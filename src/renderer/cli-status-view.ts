import type { AppState } from './app-state';
import type { CliAuth, CliAuthSetting, CliId } from '../shared/cli-auth';
import { CLI_IDS } from '../shared/cli-auth';
import { TYPE_LABELS } from '../shared/profile';

/**
 * 這一支 CLI 現在算什麼狀態。
 * 選了「API 金鑰」而且金鑰存得住的時候，工作階段一定是拿那把金鑰跑的，
 * 所以以設定為準 —— CLI 自己的登入狀態 (探測結果) 反而不是實際會用的那個。
 */
export function statusLabel(auth: CliAuth | undefined, setting?: CliAuthSetting): string {
  if (setting?.mode === 'apiKey' && setting.hasKey) return 'API 金鑰';
  return auth?.label ?? '檢查中…';
}

/** 這一支 CLI 現在有沒有東西可以用 (沒有的話晶片畫暗一階)。*/
export function statusUsable(auth: CliAuth | undefined, setting?: CliAuthSetting): boolean {
  if (setting?.mode === 'apiKey' && setting.hasKey) return true;
  return auth?.loggedIn ?? false;
}

/** 晶片上的字：「Claude · Max 訂閱」。還沒探測完 (或探測不到) 就先寫檢查中。*/
export function chipLabel(name: string, auth: CliAuth | undefined, setting?: CliAuthSetting): string {
  return `${name} · ${statusLabel(auth, setting)}`;
}

/**
 * CliStatusView：右側面板最下面那一行，四支 CLI 各一個晶片。
 * 跟其他清單一樣訂閱 AppState 重畫 (Observer)，自己不去問 main。
 */
export class CliStatusView {
  constructor(
    private readonly chips: Record<CliId, HTMLElement>,
    private readonly state: AppState,
  ) {
    this.state.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    const auth = this.state.cliAuth;
    const settings = this.state.cliSettings;
    for (const id of CLI_IDS) {
      const el = this.chips[id];
      const setting = settings?.[id];
      el.textContent = chipLabel(TYPE_LABELS[id], auth?.[id], setting);
      el.classList.toggle('muted', !statusUsable(auth?.[id], setting));
    }
  }
}
