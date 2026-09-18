import type { MyTerminalApi } from '../shared/api';
import type { RolesResult } from '../shared/ipc';
import type { RoleInfo } from '../shared/roles';
import { filterRoles, groupRoles, roleTagText } from '../shared/roles';
import type { AppState } from './app-state';
import { RescanRolesCommand, SetRolesDirCommand, errorText } from './commands';
import type { RolePickerPort } from './ports';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`找不到元素 #${id}`);
  return el as T;
};

/**
 * RolePickerDialog：角色欄位那顆「選擇…」開出來的東西。
 * 跟別的對話框同一個寫法 —— 包住原生 <dialog>，真正的動作是 Command 物件；
 * 這裡只負責把清單畫出來、把選到的那一個交回給呼叫端。
 *
 * 標頭那一排是角色庫本身的設定：資料夾、重新掃描、掃出幾個 / 略過幾個。
 * 掃描結果換了 (兩顆按鈕都會換) 就重畫，所以畫面不會停在舊答案上。
 */
export class RolePickerDialog implements RolePickerPort {
  private readonly dialog = $<HTMLDialogElement>('role-picker');
  private readonly search = $<HTMLInputElement>('role-search');
  private readonly list = $('role-picker-list');
  private readonly dirInput = $<HTMLInputElement>('roles-dir');
  private readonly status = $('roles-status');
  private readonly skipped = $<HTMLDetailsElement>('roles-skipped');
  private readonly skippedList = $('roles-skipped-list');
  private readonly errors = $('roles-errors');

  /** 目前選著的角色 id；打開的時候由呼叫端給，畫面上那一列會被標起來。*/
  private currentId: string | undefined;
  private onPick: ((role: RoleInfo) => void) | null = null;

  constructor(
    private readonly state: AppState,
    private readonly api: MyTerminalApi,
  ) {
    this.search.addEventListener('input', () => this.renderList());

    // 直接在欄位裡打路徑按 Enter 也算換資料夾 (跟按「瀏覽…」挑一個一樣)。
    this.dirInput.addEventListener('change', () => this.setDir(this.dirInput.value));
    $('roles-browse').addEventListener('click', () => void this.browse());
    $('roles-rescan').addEventListener('click', () => {
      void new RescanRolesCommand(
        this.api,
        this.state,
        (result) => this.showScan(result),
        (message) => this.showError(message),
      ).execute();
    });

    // 角色清單換了就重畫；對話框沒開著的時候畫也無所謂 (元素都在)。
    this.state.subscribe(() => this.renderList());
  }

  open(currentId: string | undefined, onPick: (role: RoleInfo) => void): void {
    this.currentId = currentId;
    this.onPick = onPick;
    this.showError('');
    this.search.value = '';
    this.renderList();
    this.dialog.showModal();
    this.search.focus();
  }

  /** 開機那次 roles:list 的結果；資料夾與狀態列都從它來。*/
  showScan(result: RolesResult): void {
    this.dirInput.value = result.dir;
    const library = result.roles.filter((role) => role.source === 'library').length;
    this.status.textContent = `${library} 個角色（${result.skipped.length} 個檔案略過）`;

    this.skipped.hidden = result.skipped.length === 0;
    this.skipped.open = false;
    this.skippedList.replaceChildren(
      ...result.skipped.map((file) => {
        const item = document.createElement('li');
        item.textContent = `${file.relPath} — ${file.reason}`;
        return item;
      }),
    );
  }

  private async browse(): Promise<void> {
    try {
      const dir = await this.api.pickRolesDir();
      // 取消就什麼都不動。
      if (dir) this.setDir(dir);
    } catch (error) {
      this.showError(errorText(error));
    }
  }

  private setDir(dir: string): void {
    void new SetRolesDirCommand(
      this.api,
      this.state,
      dir,
      (result) => this.showScan(result),
      (message) => this.showError(message),
    ).execute();
  }

  private renderList(): void {
    const matched = filterRoles(this.state.roles, this.search.value);
    this.list.replaceChildren(
      ...(matched.length === 0
        ? [note('沒有符合的角色')]
        : groupRoles(matched).flatMap((group) => [
            note(group.division, 'role-group'),
            ...group.roles.map((role) => this.row(role)),
          ])),
    );
  }

  private row(role: RoleInfo): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'role-row';
    button.dataset.id = role.id;
    if (role.id === this.currentId) button.classList.add('current');
    // 一列很窄，說明會被 … 收掉，滑過去看全文。
    button.title = role.description ? `${roleTagText(role)}\n${role.description}` : roleTagText(role);

    // 沒有說明 / 沒有分類 (內建的五個) 就不要留一個空殼在那裡。
    button.appendChild(span('role-row-name', roleTagText(role)));
    if (role.description) button.appendChild(span('role-row-desc', role.description));
    if (role.division) button.appendChild(span('role-row-division', role.division));
    button.addEventListener('click', () => this.choose(role));
    return button;
  }

  private choose(role: RoleInfo): void {
    const onPick = this.onPick;
    this.onPick = null;
    this.dialog.close();
    onPick?.(role);
  }

  private showError(message: string): void {
    this.errors.textContent = message;
  }
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function note(text: string, className = 'role-empty'): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}
