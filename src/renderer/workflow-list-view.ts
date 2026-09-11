import type { AppState } from './app-state';
import type { RunNodeStatus, RunState, RunStatus } from '../shared/workflow';

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
  }
}

/** 節點的狀態點沿用工作階段那一套 .session-dot，只是多幾種狀態。*/
export function nodeDotClass(status: RunNodeStatus): string {
  return status === 'idle' ? 'session-dot' : `session-dot ${status}`;
}

/** 費用一律三位小數：一次 claude 呼叫大約 $0.09，兩位看不出差別。*/
const money = (usd: number): string => `$${usd.toFixed(3)}`;

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
    const cost = document.createElement('span');
    cost.className = 'workflow-cost';
    cost.textContent = money(run.totalCostUsd);
    meta.appendChild(cost);
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

      if (node.costUsd !== undefined) {
        const cost = document.createElement('span');
        cost.className = 'workflow-node-cost';
        cost.textContent = money(node.costUsd);
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
