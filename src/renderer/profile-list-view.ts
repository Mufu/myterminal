import type { AppState } from './app-state';
import type { SavedProfile } from '../shared/profile';
import { TYPE_LABELS, defaultStartupCommand } from '../shared/profile';
import { closeIcon } from './session-list-view';

/** 一行說明這個設定檔連到哪裡；PowerShell 沒有額外資訊就是空字串。*/
export function profileMeta(profile: SavedProfile): string {
  switch (profile.type) {
    case 'ssh':
      return `${profile.user}@${profile.host}`;
    case 'wsl':
      return profile.distro ?? '';
    case 'claude':
    case 'codex':
      return profile.startupCommand ?? defaultStartupCommand(profile.type);
    case 'custom':
      return profile.file;
    case 'powershell':
      return '';
  }
}

/**
 * ProfileListView：工作階段清單下方的「已儲存連線」。
 * 跟 SessionListView 一樣訂閱 AppState 重畫 (Observer)；
 * 點一列就直接連線，✕ 刪除，本身不知道連線與刪除怎麼做。
 */
export class ProfileListView {
  constructor(
    private readonly list: HTMLUListElement,
    private readonly count: HTMLElement,
    private readonly state: AppState,
    private readonly onConnect: (profile: SavedProfile) => void,
    private readonly onRemove: (name: string) => void,
  ) {
    this.state.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    this.list.textContent = '';
    this.count.textContent = String(this.state.profiles.length);

    if (this.state.profiles.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'profile-empty';
      empty.textContent = '尚無儲存的連線';
      this.list.appendChild(empty);
      return;
    }

    for (const profile of this.state.profiles) {
      const item = document.createElement('li');
      item.className = 'profile-item';
      item.dataset.name = profile.name;
      item.title = `連線到 ${profile.name}`;
      item.addEventListener('click', () => this.onConnect(profile));

      const body = document.createElement('div');
      body.className = 'profile-body';

      const name = document.createElement('div');
      name.className = 'profile-name';
      name.textContent = profile.name;

      const meta = document.createElement('div');
      meta.className = 'profile-meta';

      const tag = document.createElement('span');
      tag.className = 'session-tag';
      tag.textContent = TYPE_LABELS[profile.type];
      meta.appendChild(tag);

      const detail = profileMeta(profile);
      if (detail) {
        const detailEl = document.createElement('span');
        detailEl.className = 'profile-detail';
        detailEl.textContent = detail;
        meta.appendChild(detailEl);
      }

      body.append(name, meta);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'profile-remove';
      remove.title = '刪除';
      remove.setAttribute('aria-label', `刪除 ${profile.name}`);
      remove.appendChild(closeIcon());
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        this.onRemove(profile.name);
      });

      item.append(body, remove);
      this.list.appendChild(item);
    }
  }
}
