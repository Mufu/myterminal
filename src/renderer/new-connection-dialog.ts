import type { ConnectionProfile, SessionType, BaseShell } from '../shared/profile';
import { defaultStartupCommand } from '../shared/profile';
import { validateProfile } from '../shared/validate-profile';
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
  custom: 'custom',
};

/**
 * NewConnectionDialog：包住原生 <dialog>，對外只暴露 DialogPort.open()。
 * 送出時組出 ConnectionProfile，先跑 shared 的 validateProfile 再交給呼叫端。
 */
export class NewConnectionDialog implements DialogPort {
  private readonly dialog = $<HTMLDialogElement>('new-connection');
  private readonly typeSelect = $<HTMLSelectElement>('f-type');
  private readonly errors = $<HTMLParagraphElement>('f-errors');

  constructor(private readonly onCreate: (profile: ConnectionProfile) => void) {
    this.typeSelect.addEventListener('change', () => this.syncFields());
    $('f-ok').addEventListener('click', (event) => this.submit(event));
    this.syncFields();
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
    if (this.type === 'claude' || this.type === 'codex') {
      $<HTMLInputElement>('f-startup').value = defaultStartupCommand(this.type);
    }
  }

  private submit(event: Event): void {
    const profile = this.collect();
    const errors = validateProfile(profile);
    if (errors.length > 0) {
      // 阻止 <form method="dialog"> 關閉對話框，讓使用者修正。
      event.preventDefault();
      this.errors.textContent = errors.join('\n');
      return;
    }
    this.errors.textContent = '';
    this.onCreate(profile);
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
          port: Number(value('f-port')) || 22,
        };

      case 'claude':
      case 'codex':
        return {
          type: this.type,
          name,
          cwd,
          baseShell: $<HTMLSelectElement>('f-base-shell').value as BaseShell,
          startupCommand: value('f-startup') || undefined,
        };

      case 'custom':
        return {
          type: 'custom',
          name,
          cwd,
          file: value('f-file'),
          args: value('f-args').split(/\s+/).filter(Boolean),
        };

      case 'powershell':
        return { type: 'powershell', name, cwd };
    }
  }
}
