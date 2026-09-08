import type { AppState } from './app-state';
import { TYPE_LABELS } from '../shared/profile';

/**
 * SessionListView：右側綠色面板。
 * 訂閱 AppState 重畫 (Observer)，點擊切換作用中的工作階段，✕ 關閉。
 */
export class SessionListView {
  constructor(
    private readonly list: HTMLUListElement,
    private readonly state: AppState,
    private readonly onClose: (id: string) => void,
  ) {
    this.state.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    this.list.textContent = '';

    for (const session of this.state.sessions) {
      const item = document.createElement('li');
      item.className = 'session-item';
      item.classList.toggle('active', session.id === this.state.activeSessionId);
      item.dataset.id = session.id;
      item.addEventListener('click', () => this.state.setActive(session.id));

      const name = document.createElement('div');
      name.className = 'session-name';
      name.textContent = session.name;
      name.title = session.name;

      const meta = document.createElement('div');
      meta.className = 'session-meta';

      const tag = document.createElement('span');
      tag.className = 'session-tag';
      tag.textContent = TYPE_LABELS[session.type];

      const stateLabel = document.createElement('span');
      stateLabel.className = `session-state ${session.state}`;
      stateLabel.textContent =
        session.state === 'running'
          ? session.logging
            ? ' 執行中 ● 紀錄中'
            : ' 執行中'
          : ` 已結束 (${session.exitCode ?? 0})`;

      meta.append(tag, stateLabel);

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'session-close';
      close.textContent = '✕';
      close.title = '關閉';
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        this.onClose(session.id);
      });

      item.append(name, meta, close);
      this.list.appendChild(item);
    }
  }
}
