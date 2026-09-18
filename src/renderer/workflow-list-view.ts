import type { AppState } from './app-state';
import type { RunNodeStatus, RunState, RunStatus } from '../shared/workflow';
import type { AgentKind } from '../shared/agent';
import { formatTokens } from '../shared/agent';
import type { BillingMode, CliAuthStatus } from '../shared/cli-auth';
import { usageLabel, usageTitle } from '../shared/cli-auth';
import { findRoleIn, roleTagText } from '../shared/roles';

/** 狀態徽章上的字。*/
export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case 'running':
      return '執行中';
    case 'waiting_approval':
      return '等待批准';
    case 'done':
      return '完成';
    case 'failed':
      return '失敗';
    case 'cancelled':
      return '已取消';
    case 'rejected':
      return '已退回';
  }
}

/** 節點的狀態點沿用工作階段那一套 .session-dot，只是多幾種狀態。*/
export function nodeDotClass(status: RunNodeStatus): string {
  return status === 'idle' ? 'session-dot' : `session-dot ${status}`;
}

/**
 * 這個金額要照哪一支 CLI 的登入方式寫。節點知道自己是誰跑的，
 * 執行總額 (沒有 kind) 就看 claude —— 一個工作流裡混用多支 CLI 很少見。
 * AgentKind 的四個值跟 CliAuthStatus 的四個鍵是同一組，所以直接查得到。
 */
export function usageMode(auth: CliAuthStatus | null, kind?: AgentKind): BillingMode {
  return auth?.[kind ?? 'claude'].mode ?? 'unknown';
}

const TOKENS_TITLE = 'CLI 回報的 token 總數（輸入 + 輸出）';

/**
 * 「用掉多少」在畫面上的那一小塊：有金額就寫金額，沒有金額 (Codex 只回報
 * token 數) 就寫 token 數，兩個都沒有就不寫。
 */
export function usageBadge(
  costUsd: number | undefined,
  tokens: number | undefined,
  mode: BillingMode,
): { text: string; title: string } | null {
  if (tokens !== undefined && !costUsd) {
    return { text: `${formatTokens(tokens)} tokens`, title: TOKENS_TITLE };
  }
  if (costUsd === undefined) return null;
  return { text: usageLabel(costUsd, mode), title: usageTitle(mode) };
}

/**
 * WorkflowListView：右側「工作流」清單，一個執行一塊。
 * 跟其他兩個清單一樣訂閱 AppState 重畫 (Observer)，本身不知道
 * 批准／退回／取消實際上怎麼做，也不知道怎麼切換終端機。
 */
export class WorkflowListView {
  constructor(
    private readonly list: HTMLUListElement,
    private readonly state: AppState,
    private readonly onResume: (runId: string, approved: boolean) => void,
    private readonly onCancel: (run: RunState) => void,
    private readonly onSelectSession: (sessionId: string) => void,
  ) {
    this.state.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    this.list.textContent = '';

    if (this.state.runs.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'workflow-empty';
      empty.textContent = '尚無工作流執行';
      this.list.appendChild(empty);
      return;
    }

    for (const run of this.state.runs) this.list.appendChild(this.renderRun(run));
  }

  private renderRun(run: RunState): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'workflow-run';
    item.dataset.run = run.runId;

    const head = document.createElement('div');
    head.className = 'workflow-head';

    const name = document.createElement('div');
    name.className = 'workflow-name';
    name.textContent = run.name;
    name.title = run.name;

    const status = document.createElement('span');
    status.className = `workflow-status ${run.status}`;
    status.textContent = runStatusLabel(run.status);

    head.append(name, status);

    const meta = document.createElement('div');
    meta.className = 'workflow-meta';
    const usage = usageBadge(run.totalCostUsd, run.totalTokens, usageMode(this.state.cliAuth));
    if (usage) {
      const cost = document.createElement('span');
      cost.className = 'workflow-cost';
      cost.textContent = usage.text;
      cost.title = usage.title;
      meta.appendChild(cost);
    }
    if (run.error) {
      const error = document.createElement('span');
      error.className = 'workflow-error';
      error.textContent = run.error;
      error.title = run.error;
      meta.appendChild(error);
    }

    item.append(head, meta, this.renderNodes(run));

    if (run.status === 'waiting_approval') {
      const question = document.createElement('p');
      question.className = 'workflow-question';
      question.textContent = run.question ?? '';
      item.appendChild(question);
      item.appendChild(
        actions([
          ['workflow-approve', '批准', () => this.onResume(run.runId, true)],
          ['workflow-reject', '退回', () => this.onResume(run.runId, false)],
        ]),
      );
    } else if (run.status === 'running') {
      item.appendChild(actions([['workflow-cancel', '取消', () => this.onCancel(run)]]));
    }

    return item;
  }

  private renderNodes(run: RunState): HTMLUListElement {
    const nodes = document.createElement('ul');
    nodes.className = 'workflow-nodes';

    for (const [nodeId, node] of Object.entries(run.nodes)) {
      const row = document.createElement('li');
      row.className = 'workflow-node';
      row.dataset.node = nodeId;

      const dot = document.createElement('span');
      dot.className = nodeDotClass(node.status);

      const label = document.createElement('span');
      label.className = 'workflow-node-label';
      label.textContent = node.label;

      row.append(dot, label);

      // 有角色的節點在名字後面貼一個標籤，一眼看得出這一步是誰在做。
      const role = node.role ? findRoleIn(this.state.roles, node.role) : undefined;
      if (role) {
        const tag = document.createElement('span');
        tag.className = 'role-tag';
        tag.textContent = roleTagText(role);
        tag.title = roleTagText(role);
        row.appendChild(tag);
      }

      const usage = usageBadge(
        node.costUsd,
        node.tokens,
        usageMode(this.state.cliAuth, node.kind),
      );
      if (usage) {
        const cost = document.createElement('span');
        cost.className = 'workflow-node-cost';
        cost.textContent = usage.text;
        cost.title = usage.title;
        row.appendChild(cost);
      }

      // 有工作階段的節點點一下就切過去看那個終端機。
      const sessionId = node.sessionId;
      if (sessionId) {
        row.classList.add('has-session');
        row.title = '切換到這個節點的終端機';
        row.addEventListener('click', () => this.onSelectSession(sessionId));
      }
      nodes.appendChild(row);
    }
    return nodes;
  }
}

function actions(buttons: Array<[string, string, () => void]>): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'workflow-actions';
  for (const [className, label, onClick] of buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', onClick);
    row.appendChild(button);
  }
  return row;
}
