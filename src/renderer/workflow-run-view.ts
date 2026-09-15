import type { RunNodeStatus, RunState } from '../shared/workflow';
import type { CliAuthStatus } from '../shared/cli-auth';
import { usageLabel, usageTitle } from '../shared/cli-auth';
import { nodeDotClass, runStatusLabel, usageMode } from './workflow-list-view';

/**
 * 畫布上的「執行檢視」：把一次執行的狀態蓋在既有的節點卡片上。
 * 挑哪一次執行、一張卡片上要寫什麼都是純函式 (測得到)，
 * RunOverlay 只負責把它畫出來 —— 而且只加／刪自己那幾個元素，
 * 不碰 WorkflowEditorModel：看執行狀況不算編輯，工作流不會因此變髒。
 */

/** 節點狀態在卡片上的字。*/
export function nodeStatusLabel(status: RunNodeStatus): string {
  switch (status) {
    case 'idle':
      return '等待';
    case 'running':
      return '執行中';
    case 'done':
      return '完成';
    case 'failed':
      return '失敗';
    case 'waiting':
      return '等待批准';
    case 'skipped':
      return '略過';
    case 'cancelled':
      return '已取消';
  }
}

/**
 * 畫布上這份工作流「現在」該看哪一次執行：還在跑的優先 ——
 * 使用者盯著畫布就是在看那一次；都跑完了就看最近開始的那一次。
 */
export function latestRunFor(runs: RunState[], workflowId: string): RunState | null {
  const mine = runs.filter((run) => run.workflowId === workflowId);
  if (mine.length === 0) return null;
  const live = mine.filter(
    (run) => run.status === 'running' || run.status === 'waiting_approval',
  );
  const pool = live.length > 0 ? live : mine;
  return pool.reduce((latest, run) => (run.startedAt >= latest.startedAt ? run : latest));
}

/** 一張卡片上要畫的東西；沒有執行 (或這次執行沒有這個節點) 就是 null。*/
export interface CardOverlay {
  status: RunNodeStatus;
  label: string;
  /** 這個節點用掉的額度；CLI 還沒回報就沒有。*/
  usage?: string;
  /** 有的話卡片上就給一個「輸出」按鈕切過去看。*/
  sessionId?: string;
  /** 整次執行就停在這個批准節點等人：卡片上直接給批准／退回。*/
  waitingApproval: boolean;
}

export function cardOverlay(
  run: RunState | null,
  nodeId: string,
  auth: CliAuthStatus | null = null,
): CardOverlay | null {
  const node = run?.nodes[nodeId];
  if (!run || !node) return null;

  const overlay: CardOverlay = {
    status: node.status,
    label: nodeStatusLabel(node.status),
    waitingApproval: node.status === 'waiting' && run.status === 'waiting_approval',
  };
  if (node.costUsd !== undefined) {
    overlay.usage = usageLabel(node.costUsd, usageMode(auth, node.kind));
  }
  if (node.sessionId) overlay.sessionId = node.sessionId;
  return overlay;
}

/** 覆蓋層上的動作交給誰做；它自己不知道怎麼切終端機也不知道怎麼批准。*/
export interface RunOverlayHandlers {
  openTerminal(sessionId: string): void;
  resume(runId: string, approved: boolean): void;
  cancel(run: RunState): void;
}

/** 覆蓋層加上去的元素；重畫時先照這個清單清掉，卡片本身不動。*/
const OVERLAY_PARTS = '.wf-run, .wf-run-actions';

export class RunOverlay {
  private readonly strip: HTMLElement;

  constructor(
    private readonly handlers: RunOverlayHandlers,
    strip: HTMLElement,
  ) {
    this.strip = strip;
  }

  /** 編輯列上那條執行摘要；沒有執行就收起來。*/
  paintStrip(run: RunState | null, auth: CliAuthStatus | null): void {
    this.strip.textContent = '';
    this.strip.hidden = run === null;
    if (!run) return;

    const status = document.createElement('span');
    status.className = `workflow-status ${run.status}`;
    status.textContent = runStatusLabel(run.status);

    const mode = usageMode(auth);
    const cost = document.createElement('span');
    cost.className = 'workflow-cost';
    cost.textContent = usageLabel(run.totalCostUsd, mode);
    cost.title = usageTitle(mode);

    this.strip.append(label('wf-run-title', '執行：'), status, cost);
    if (run.status === 'running') {
      this.strip.appendChild(
        this.button('wf-run-cancel', '取消', () => this.handlers.cancel(run)),
      );
    }
    if (run.error) {
      const error = label('workflow-error', run.error);
      error.title = run.error;
      this.strip.appendChild(error);
    }
  }

  /** 一張卡片的執行狀態；沒有就把上一次畫的收乾淨。*/
  paintCard(card: HTMLElement, nodeId: string, run: RunState | null, auth: CliAuthStatus | null): void {
    for (const part of Array.from(card.querySelectorAll(OVERLAY_PARTS))) part.remove();

    const overlay = cardOverlay(run, nodeId, auth);
    if (!overlay || !run) {
      delete card.dataset.runStatus;
      return;
    }
    card.dataset.runStatus = overlay.status;

    const line = document.createElement('div');
    line.className = 'wf-run';

    const dot = document.createElement('span');
    dot.className = nodeDotClass(overlay.status);
    line.append(dot, label('wf-run-label', overlay.label));
    if (overlay.usage) line.appendChild(label('wf-run-cost', overlay.usage));

    const sessionId = overlay.sessionId;
    if (sessionId) {
      line.appendChild(
        this.button('wf-open-terminal', '輸出', () => this.handlers.openTerminal(sessionId)),
      );
    }
    card.appendChild(line);

    if (!overlay.waitingApproval) return;
    const actions = document.createElement('div');
    actions.className = 'wf-run-actions';
    actions.append(
      this.button('wf-approve', '批准', () => this.handlers.resume(run.runId, true)),
      this.button('wf-reject', '退回', () => this.handlers.resume(run.runId, false)),
    );
    card.appendChild(actions);
  }

  /**
   * 卡片上的按鈕要吃掉 pointerdown —— 畫布是用它開始拖曳的，
   * 不擋的話按一下批准會順便把節點拖走。
   */
  private button(className: string, text: string, onClick: () => void): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    el.textContent = text;
    el.addEventListener('pointerdown', (event) => event.stopPropagation());
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return el;
  }
}

function label(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}
