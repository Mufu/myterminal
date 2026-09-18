import type { ConnectionProfile, SessionType, BaseShell } from '../shared/profile';
import type { AgentKind, AgentPermission } from '../shared/agent';
import { PERMISSION_LABELS, PERMISSIONS } from '../shared/agent';
import type { RoleInfo } from '../shared/roles';
import { ROLES, roleTagText } from '../shared/roles';
import { defaultStartupCommand, isCliType } from '../shared/profile';
import { validateProfile } from '../shared/validate-profile';
import { parseArgs } from '../shared/parse-args';
import type { DialogPort, RolePickerPort } from './ports';

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
  private readonly roleName = $('f-agent-role-name');
  private readonly permissionSelect = $<HTMLSelectElement>('f-agent-permission');

  /** 選著的角色；沒選就是「無」(不套任何前置指示)。*/
  private role: RoleInfo | null = null;

  constructor(
    private readonly onCreate: (profile: ConnectionProfile, save: boolean) => void,
    /** 「選擇…」開出來的角色選擇器。*/
    private readonly picker: RolePickerPort,
    /** 目前的角色清單 (內建 + 角色庫)，驗證時要用。*/
    private readonly roles: () => readonly RoleInfo[] = () => ROLES,
  ) {
    this.typeSelect.addEventListener('change', () => this.syncFields());
    this.fillPermissions();
    $('f-agent-role-pick').addEventListener('click', () =>
      this.picker.open(this.role?.id, (role) => this.setRole(role)),
    );
    $('f-agent-role-clear').addEventListener('click', () => this.setRole(null));
    $('f-ok').addEventListener('click', (event) => this.submit(event));
    this.syncFields();
    this.renderRole();
  }

  /** 權限的三檔；「完全放行」的標籤自己帶著警語。*/
  private fillPermissions(): void {
    for (const permission of PERMISSIONS) {
      const option = document.createElement('option');
      option.value = permission;
      option.textContent = PERMISSION_LABELS[permission];
      this.permissionSelect.appendChild(option);
    }
  }

  /** 換角色時把「權限」帶到那個角色的預設值；只在換的時候動它。*/
  private setRole(role: RoleInfo | null): void {
    this.role = role;
    if (role) this.permissionSelect.value = role.defaultPermission;
    this.renderRole();
  }

  private renderRole(): void {
    this.roleName.textContent = this.role ? roleTagText(this.role) : '無';
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
    }
  }

  private submit(event: Event): void {
    const profile = this.collect();
    // 勾了「儲存此連線設定」名稱才是必填的 —— 設定檔以名稱為鍵。
    const save = this.saveProfile.checked;
    const errors = validateProfile(profile, save, this.roles());
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
          permission: this.permissionSelect.value as AgentPermission,
          role: this.role?.id,
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
