import type { AppState } from './app-state';
import type { SessionInfo } from '../shared/session';
import { TYPE_LABELS } from '../shared/profile';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 清單上那一列的類型標籤；agent 任務要看得出是哪個 CLI 在跑。*/
export function sessionTag(session: SessionInfo): string {
  if (session.type !== 'agent') return TYPE_LABELS[session.type];
  return session.agentKind === 'codex' ? 'Codex 任務' : 'Claude 任務';
}

/** 接手：把這次 agent 執行接到真的終端機裡繼續。*/
function takeOverIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M1 6h6M5 3.5L7.5 6 5 8.5M9.5 1.5v9');
  svg.appendChild(path);
  return svg;
}

/** 線稿圖示：關閉工作階段與刪除設定檔共用。*/
export function closeIcon(): SVGSVGElement {
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
    private readonly onTakeOver: (session: SessionInfo) => void,
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
      tag.textContent = sessionTag(session);

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

      // 有 session id 才接得回去，所以 CLI 回報之前不顯示。
      if (session.agentSessionId) {
        const takeOver = document.createElement('button');
        takeOver.type = 'button';
        takeOver.className = 'session-takeover';
        takeOver.title = '在真的終端機裡接續這段對話';
        takeOver.setAttribute('aria-label', `接手 ${session.name}`);
        const label = document.createElement('span');
        label.textContent = '接手';
        takeOver.append(takeOverIcon(), label);
        takeOver.addEventListener('click', (event) => {
          event.stopPropagation();
          this.onTakeOver(session);
        });
        meta.appendChild(takeOver);
      }
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
