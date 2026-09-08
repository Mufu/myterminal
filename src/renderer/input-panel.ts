import type { AppState } from './app-state';
import type { InputPanelPort } from './ports';

/**
 * InputPanel：「輸入字」開關控制的多行輸入區。
 * 實作 InputPanelPort，讓 SendInputCommand 不必知道 DOM。
 */
export class InputPanel implements InputPanelPort {
  constructor(
    private readonly panel: HTMLElement,
    private readonly textarea: HTMLTextAreaElement,
    private readonly targetName: HTMLElement,
    private readonly targetDot: HTMLElement,
    private readonly state: AppState,
    private readonly onVisibilityChange: () => void,
  ) {
    state.subscribe(() => {
      this.sync(state.inputPanelVisible);
      this.renderTarget();
    });
    this.sync(state.inputPanelVisible);
    this.renderTarget();
  }

  getText(): string {
    return this.textarea.value;
  }

  clear(): void {
    this.textarea.value = '';
    this.textarea.focus();
  }

  /** 標題列顯示這段文字會送到哪個工作階段。*/
  private renderTarget(): void {
    const session = this.state.activeSession();
    this.targetName.textContent = session?.name ?? '—';
    this.targetDot.hidden = session === null;
    this.targetDot.className = session ? `session-dot ${session.state}` : 'session-dot';
  }

  private sync(visible: boolean): void {
    if (this.panel.hidden === !visible) return;
    this.panel.hidden = !visible;
    // 面板佔掉高度，終端機要重新量測。
    this.onVisibilityChange();
    if (visible) this.textarea.focus();
  }
}
