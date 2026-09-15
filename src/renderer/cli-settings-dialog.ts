import type { ApiProvider, CliAuthSetting, CliId } from '../shared/cli-auth';
import { CLI_IDS, defaultCliMode } from '../shared/cli-auth';
import type { SaveCliSettingRequest } from '../shared/ipc';
import type { MyTerminalApi } from '../shared/api';
import type { AppState } from './app-state';
import { statusLabel } from './cli-status-view';
import { ClearCliKeyCommand, LoginCliCommand, SaveCliSettingCommand } from './commands';
import type { DialogPort } from './ports';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`找不到元素 #${id}`);
  return el as T;
};

/** OpenCode 那一列沒有「登入」，所以這些元素本來就可能不存在。*/
const maybe = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

/**
 * CliSettingsDialog：一支 CLI 一列，選「登入」或「API 金鑰」。
 * 跟 NewConnectionDialog 同一個寫法 —— 包住原生 <dialog>，對外只有 open()；
 * 真正的動作都是 Command 物件，這裡只負責把欄位收進來、把結果畫回去。
 */
export class CliSettingsDialog implements DialogPort {
  private readonly dialog = $<HTMLDialogElement>('cli-settings');
  private readonly errors = $<HTMLParagraphElement>('cli-errors');

  constructor(
    private readonly state: AppState,
    private readonly api: MyTerminalApi,
    /** 登入的工作階段開好之後要做的事 (關對話框、切過去看它)。*/
    private readonly onLogin: (sessionId: string) => void | Promise<void>,
  ) {
    for (const id of CLI_IDS) this.wire(id);
    // 探測結果或設定變了就換狀態文字；使用者正在打的金鑰不會被動到。
    this.state.subscribe(() => this.renderStatus());
    this.renderStatus();
  }

  open(): void {
    this.showErrors([]);
    for (const id of CLI_IDS) this.fill(id);
    this.dialog.showModal();
  }

  private wire(id: CliId): void {
    for (const mode of ['login', 'apiKey']) {
      maybe<HTMLInputElement>(`cli-${id}-mode-${mode}`)?.addEventListener('change', () =>
        this.syncRow(id),
      );
    }

    maybe<HTMLButtonElement>(`cli-${id}-login`)?.addEventListener('click', () => {
      void new LoginCliCommand(this.api, id, (sessionId) => this.startedLogin(sessionId), (m) =>
        this.showErrors(m),
      ).execute();
    });

    $<HTMLButtonElement>(`cli-${id}-save`).addEventListener('click', () => {
      const hasKey = this.setting(id)?.hasKey ?? false;
      void new SaveCliSettingCommand(
        this.api,
        this.collect(id),
        hasKey,
        (settings) => this.saved(settings, id),
        (messages) => this.showErrors(messages),
      ).execute();
    });

    $<HTMLButtonElement>(`cli-${id}-clear`).addEventListener('click', () => {
      void new ClearCliKeyCommand(
        this.api,
        id,
        (settings) => this.saved(settings, id),
        (messages) => this.showErrors(messages),
      ).execute();
    });
  }

  private setting(id: CliId): CliAuthSetting | undefined {
    return this.state.cliSettings?.[id];
  }

  /** 存完 (或清完) 之後把新的設定送回 AppState，那一列也重畫一次。*/
  private saved(settings: Record<CliId, CliAuthSetting>, id: CliId): void {
    this.state.setCliSettings(settings);
    this.fill(id);
  }

  private async startedLogin(sessionId: string): Promise<void> {
    this.dialog.close();
    await this.onLogin(sessionId);
  }

  /** 把一整列的欄位填成目前存著的樣子；金鑰格永遠是空的，存著的只顯示提示字。*/
  private fill(id: CliId): void {
    const setting = this.setting(id);
    const mode = setting?.mode ?? defaultCliMode(id);
    const loginRadio = maybe<HTMLInputElement>(`cli-${id}-mode-login`);
    if (loginRadio) loginRadio.checked = mode === 'login';
    $<HTMLInputElement>(`cli-${id}-mode-apiKey`).checked = mode === 'apiKey';

    const key = $<HTMLInputElement>(`cli-${id}-key`);
    key.value = '';
    key.placeholder = setting?.hasKey ? '已儲存' : '貼上 API 金鑰';

    if (id === 'opencode') {
      $<HTMLSelectElement>('cli-opencode-provider').value = setting?.provider ?? 'anthropic';
      $<HTMLInputElement>('cli-opencode-model').value = setting?.model ?? '';
    }

    this.syncRow(id);
  }

  /** 依目前選的方式決定哪些欄位還能動。*/
  private syncRow(id: CliId): void {
    const apiKeyMode = $<HTMLInputElement>(`cli-${id}-mode-apiKey`).checked;
    $<HTMLInputElement>(`cli-${id}-key`).disabled = !apiKeyMode;
    const login = maybe<HTMLButtonElement>(`cli-${id}-login`);
    if (login) login.disabled = apiKeyMode;
    $<HTMLButtonElement>(`cli-${id}-clear`).disabled = !this.setting(id)?.hasKey;
    if (id === 'opencode') {
      $<HTMLSelectElement>('cli-opencode-provider').disabled = !apiKeyMode;
    }
  }

  private renderStatus(): void {
    for (const id of CLI_IDS) {
      $(`cli-${id}-status`).textContent = statusLabel(this.state.cliAuth?.[id], this.setting(id));
    }
  }

  private collect(id: CliId): SaveCliSettingRequest {
    const request: SaveCliSettingRequest = {
      id,
      mode: $<HTMLInputElement>(`cli-${id}-mode-apiKey`).checked ? 'apiKey' : 'login',
      // 留空代表沿用已經存著的那一把，不必每次重打。
      apiKey: $<HTMLInputElement>(`cli-${id}-key`).value.trim() || undefined,
    };
    if (id === 'opencode') {
      request.provider = $<HTMLSelectElement>('cli-opencode-provider').value as ApiProvider;
      request.model = $<HTMLInputElement>('cli-opencode-model').value.trim();
    }
    return request;
  }

  private showErrors(messages: string[]): void {
    this.errors.textContent = messages.join('\n');
  }
}
