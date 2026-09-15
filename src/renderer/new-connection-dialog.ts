import type { ConnectionProfile, SessionType, BaseShell } from '../shared/profile';
import type { AgentKind } from '../shared/agent';
import type { AgentRole } from '../shared/roles';
import { ROLES, findRole } from '../shared/roles';
import { defaultStartupCommand, isCliType } from '../shared/profile';
import { validateProfile } from '../shared/validate-profile';
import { parseArgs } from '../shared/parse-args';
import type { DialogPort } from './ports';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`找不到元素 #${id}`);
  return el as T;
};

/** 依類型決定要顯示哪一組欄位。*/
const GROUP_FOR: Record<SessionType, string | null> = {
  powershell: null,
  wsl: 'wsl',
  ssh: 'ssh',
  claude: 'agent',
  codex: 'agent',
  muse: 'agent',
  opencode: 'agent',
  custom: 'custom',
  agent: 'agent-task',
};

/**
 * NewConnectionDialog：包住原生 <dialog>，對外只暴露 DialogPort.open()。
 * 送出時組出 ConnectionProfile，先跑 shared 的 validateProfile 再交給呼叫端。
 */
export class NewConnectionDialog implements DialogPort {
  private readonly dialog = $<HTMLDialogElement>('new-connection');
  private readonly typeSelect = $<HTMLSelectElement>('f-type');
  private readonly errors = $<HTMLParagraphElement>('f-errors');
  private readonly saveProfile = $<HTMLInputElement>('f-save');
  private readonly roleSelect = $<HTMLSelectElement>('f-agent-role');

  constructor(private readonly onCreate: (profile: ConnectionProfile, save: boolean) => void) {
    this.typeSelect.addEventListener('change', () => this.syncFields());
    this.fillRoles();
    this.roleSelect.addEventListener('change', () => this.applyRoleDefault());
    $('f-ok').addEventListener('click', (event) => this.submit(event));
    this.syncFields();
  }

  /** 角色選項就是 ROLES，第一個是「無」(不套任何前置指示)。*/
  private fillRoles(): void {
    for (const { id, label } of [{ id: '', label: '無' }, ...ROLES]) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = label;
      this.roleSelect.appendChild(option);
    }
  }

  /** 換角色時把「允許修改檔案」帶到那個角色的預設值；只在換的時候動它。*/
  private applyRoleDefault(): void {
    const role = findRole(this.roleSelect.value);
    if (role) $<HTMLInputElement>('f-agent-edits').checked = role.defaultAllowEdits;
  }

  open(): void {
    this.errors.textContent = '';
    this.dialog.showModal();
    this.typeSelect.focus();
  }

  private get type(): SessionType {
    return this.typeSelect.value as SessionType;
  }

  /** 切換類型時顯示對應欄位，並補上 agent 的預設啟動指令。*/
  private syncFields(): void {
    const wanted = GROUP_FOR[this.type];
    for (const group of document.querySelectorAll<HTMLElement>('.field-group')) {
      group.hidden = group.dataset.for !== wanted;
    }
    if (isCliType(this.type)) {
      $<HTMLInputElement>('f-startup').value = defaultStartupCommand(this.type);
      this.syncBaseShell();
    }
  }

  /**
   * Muse Code 只有 Linux 版：PowerShell 那個選項關掉並強制選 WSL，
   * 換回其他 CLI 時再把它放回來 (並且回到預設的 PowerShell)。
   */
  private syncBaseShell(): void {
    const select = $<HTMLSelectElement>('f-base-shell');
    const powershell = select.querySelector<HTMLOptionElement>('option[value="powershell"]');
    if (!powershell) return;
    const museOnly = this.type === 'muse';
    const wasMuseOnly = powershell.disabled;
    powershell.disabled = museOnly;
    powershell.hidden = museOnly;
    if (museOnly) select.value = 'wsl';
    else if (wasMuseOnly) select.value = 'powershell';
  }

  private submit(event: Event): void {
    const profile = this.collect();
    // 勾了「儲存此連線設定」名稱才是必填的 —— 設定檔以名稱為鍵。
    const save = this.saveProfile.checked;
    const errors = validateProfile(profile, save);
    if (errors.length > 0) {
      // 阻止 <form method="dialog"> 關閉對話框，讓使用者修正。
      event.preventDefault();
      this.errors.textContent = errors.join('\n');
      return;
    }
    this.errors.textContent = '';
    this.onCreate(profile, save);
  }

  /**
   * 連接埠：留空、或打了不是數字的東西 (type=number 的 badInput，value 會是空字串)
   * 都收成 NaN 交給 validateProfile 報錯 —— 不能默默變成 22。
   */
  private port(): number {
    const input = $<HTMLInputElement>('f-port');
    if (input.validity.badInput || !input.value.trim()) return Number.NaN;
    return Number(input.value);
  }

  private collect(): ConnectionProfile {
    const value = (id: string): string => $<HTMLInputElement>(id).value.trim();
    const name = value('f-name') || undefined;
    const cwd = value('f-cwd') || undefined;

    switch (this.type) {
      case 'wsl':
        return { type: 'wsl', name, cwd, distro: value('f-distro') || undefined };

      case 'ssh':
        return {
          type: 'ssh',
          name,
          cwd,
          host: value('f-host'),
          user: value('f-user'),
          port: this.port(),
        };

      case 'claude':
      case 'codex':
      case 'muse':
      case 'opencode':
        return {
          type: this.type,
          name,
          cwd,
          baseShell: $<HTMLSelectElement>('f-base-shell').value as BaseShell,
          startupCommand: value('f-startup') || undefined,
        };

      case 'agent':
        return {
          type: 'agent',
          name,
          cwd,
          kind: $<HTMLSelectElement>('f-agent-kind').value as AgentKind,
          prompt: $<HTMLTextAreaElement>('f-agent-prompt').value.trim(),
          allowEdits: $<HTMLInputElement>('f-agent-edits').checked,
          role: (this.roleSelect.value as AgentRole) || undefined,
        };

      case 'custom':
        return {
          type: 'custom',
          name,
          cwd,
          file: value('f-file'),
          args: parseArgs(value('f-args')),
        };

      case 'powershell':
        return { type: 'powershell', name, cwd };
    }
  }
}
