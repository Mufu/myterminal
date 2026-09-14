import type { AppState } from './app-state';
import type { CliAuth } from '../shared/cli-auth';

/** 晶片上的字：「Claude · Max 訂閱」。還沒探測完 (或探測不到) 就先寫檢查中。*/
export function chipLabel(name: string, auth: CliAuth | undefined): string {
  return `${name} · ${auth?.label ?? '檢查中…'}`;
}

/**
 * CliStatusView：右側面板最下面那一行，兩個 CLI 各一個晶片。
 * 跟其他清單一樣訂閱 AppState 重畫 (Observer)，自己不去問 main。
 */
export class CliStatusView {
  constructor(
    private readonly claude: HTMLElement,
    private readonly codex: HTMLElement,
    private readonly state: AppState,
  ) {
    this.state.subscribe(() => this.render());
    this.render();
  }

  private render(): void {
    const auth = this.state.cliAuth;
    this.chip(this.claude, 'Claude', auth?.claude);
    this.chip(this.codex, 'Codex', auth?.codex);
  }

  private chip(el: HTMLElement, name: string, auth: CliAuth | undefined): void {
    el.textContent = chipLabel(name, auth);
    // 沒登入 (或判斷不出來) 的那一個用暗色，一眼看得出這個 CLI 現在不能用。
    el.classList.toggle('muted', !auth?.loggedIn);
  }
}
