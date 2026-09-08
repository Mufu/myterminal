import type { AppState } from './app-state';
import { TYPE_LABELS } from '../shared/profile';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 線稿圖示：只有關閉用得到，所以直接寫死路徑。*/
function closeIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M2 2l8 8M10 2l-8 8');
  svg.appendChild(path);
  return svg;
}

/**
 * SessionListView：右側工作階段清單。
 * 訂閱 AppState 重畫 (Observer)，點擊切換作用中的工作階段，✕ 關閉。
 */
export class SessionListView {
  constructor(
    private readonly list: HTMLUListElement,
    private readonly count: HTMLElement,
    private readonly state: AppState,
    private readonly onClose: (id: string) => void,
  ) {
    this.state.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    this.list.textContent = '';
    this.count.textContent = String(this.state.sessions.length);

    for (const session of this.state.sessions) {
      const running = session.state === 'running';

      const item = document.createElement('li');
      item.className = 'session-item';
      item.classList.toggle('active', session.id === this.state.activeSessionId);
      item.classList.toggle('exited', !running);
      item.dataset.id = session.id;
      item.addEventListener('click', () => this.state.setActive(session.id));

      const dot = document.createElement('span');
      dot.className = `session-dot ${session.state}`;

      const body = document.createElement('div');
      body.className = 'session-body';

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
      if (running && session.logging) {
        // 紀錄中：狀態換成紅點 + 紀錄中，作用中的紅點就是錄影指示。
        stateLabel.classList.add('logging');
        const recDot = document.createElement('span');
        recDot.className = 'session-dot logging';
        stateLabel.append(recDot, '紀錄中');
      } else {
        stateLabel.textContent = running ? '執行中' : `已結束 (${session.exitCode ?? 0})`;
      }

      meta.append(tag, stateLabel);
      body.append(name, meta);

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'session-close';
      close.title = '關閉';
      close.setAttribute('aria-label', `關閉 ${session.name}`);
      close.appendChild(closeIcon());
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        this.onClose(session.id);
      });

      item.append(dot, body, close);
      this.list.appendChild(item);
    }
  }
}
