import type { AppState } from './app-state';
import type { InputPanelPort } from './ports';
import { InputHistory, atFirstLine, atLastLine } from './input-history';

/** 面板高度與「送出後保留」記在 localStorage，下次開 app 還在。*/
export const HEIGHT_KEY = 'myterminal.inputPanelHeight';
export const KEEP_KEY = 'myterminal.inputKeep';

export interface InputPanelElements {
  panel: HTMLElement;
  textarea: HTMLTextAreaElement;
  targetName: HTMLElement;
  targetDot: HTMLElement;
  /** 「送出後保留」：同一句話要送好幾次時不必重打。*/
  keep: HTMLInputElement;
}

/**
 * InputPanel：「輸入字」開關控制的多行輸入區。
 * 實作 InputPanelPort，讓 SendInputCommand 不必知道 DOM；
 * 歷史與草稿的邏輯在 input-history.ts（純函式，單獨測）。
 */
export class InputPanel implements InputPanelPort {
  private readonly history = new InputHistory();
  /** 上一次算過的作用中工作階段；換了才要換草稿。*/
  private sessionId: string | null;
  /**
   * 畫布上的「開終端機並啟動」代好的提示。setText 的當下作用中的還是舊的
   * 工作階段（createSession 是非同步的），所以先記著，等新的那個切過來再填進去，
   * 舊的那一個草稿也就不會被它蓋掉。
   */
  private prefill: string | null = null;

  constructor(
    private readonly el: InputPanelElements,
    private readonly state: AppState,
    /** Ctrl+Enter：跟工具列的「送出」是同一個 Command。*/
    private readonly send: () => void,
    private readonly onVisibilityChange: (visible: boolean) => void,
    /** 面板長高 / 變矮了，上面的終端機要重新量測。*/
    private readonly onHeightChange: () => void,
  ) {
    this.sessionId = state.activeSessionId;
    this.restoreHeight();
    this.el.keep.checked = read(KEEP_KEY) === '1';
    this.el.keep.addEventListener('change', () => {
      write(KEEP_KEY, this.el.keep.checked ? '1' : '');
    });

    this.el.textarea.addEventListener('input', () => {
      if (this.sessionId) this.history.setText(this.sessionId, this.el.textarea.value);
    });
    this.el.textarea.addEventListener('keydown', (event) => this.handleKey(event));
    // 拉高 / 拉矮輸入區（CSS 的 resize: vertical）之後終端機要重新量測。
    new ResizeObserver(() => this.heightChanged()).observe(this.el.textarea);

    state.subscribe(() => {
      this.syncSession();
      this.sync(state.inputPanelVisible);
      this.renderTarget();
    });
    this.sync(state.inputPanelVisible);
    this.renderTarget();
  }

  getText(): string {
    return this.el.textarea.value;
  }

  setText(text: string): void {
    this.el.textarea.value = text;
    this.prefill = text;
  }

  /** 送出成功了：進歷史、依「送出後保留」決定清不清空，焦點留在輸入區。*/
  sent(): void {
    const id = this.state.activeSessionId;
    if (id) {
      const text = this.el.textarea.value;
      this.history.push(id, text);
      if (this.el.keep.checked) this.history.setText(id, text);
      this.el.textarea.value = this.history.text(id);
    }
    // 送完通常還要接著寫下一段，所以焦點不交出去。
    this.el.textarea.focus();
  }

  /**
   * Ctrl+Enter 送出（單獨的 Enter 還是換行，多行訊息才好寫）；
   * ↑ / ↓ 只有在游標已經在第一行 / 最後一行時才叫回送出過的內容。
   */
  private handleKey(event: KeyboardEvent): void {
    if (event.isComposing) return;

    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.send();
      return;
    }

    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const older = event.key === 'ArrowUp';
    const { value, selectionStart } = this.el.textarea;
    if (older ? !atFirstLine(value, selectionStart) : !atLastLine(value, selectionStart)) return;

    const id = this.state.activeSessionId;
    if (!id) return;
    const recalled = this.history.recall(id, older ? -1 : 1);
    if (recalled === null) return;
    event.preventDefault();
    this.el.textarea.value = recalled;
    // 游標放到最後，接著打字就是改這一份副本。
    this.el.textarea.setSelectionRange(recalled.length, recalled.length);
  }

  /** 換工作階段：每個工作階段記著自己還沒送出的草稿。*/
  private syncSession(): void {
    const id = this.state.activeSessionId;
    if (id === this.sessionId) return;
    this.sessionId = id;
    if (!id) return;
    if (this.prefill !== null) {
      // 代好的提示是給「剛開出來的那個」工作階段的。
      this.history.setText(id, this.prefill);
      this.prefill = null;
    }
    this.el.textarea.value = this.history.text(id);
  }

  /** 標題列顯示這段文字會送到哪個工作階段。*/
  private renderTarget(): void {
    const session = this.state.activeSession();
    this.el.targetName.textContent = session?.name ?? '—';
    this.el.targetDot.hidden = session === null;
    this.el.targetDot.className = session ? `session-dot ${session.state}` : 'session-dot';
  }

  private sync(visible: boolean): void {
    if (this.el.panel.hidden === !visible) return;
    this.el.panel.hidden = !visible;
    // 面板佔掉高度，終端機要重新量測。
    this.onVisibilityChange(visible);
    if (visible) this.el.textarea.focus();
  }

  private restoreHeight(): void {
    const saved = Number(read(HEIGHT_KEY));
    if (saved > 0) this.el.textarea.style.height = `${saved}px`;
  }

  private heightChanged(): void {
    // 面板收起來的時候量到的是 0，那個不要記。
    const height = this.el.textarea.offsetHeight;
    if (height > 0) write(HEIGHT_KEY, String(height));
    this.onHeightChange();
  }
}

const read = (key: string): string | null => window.localStorage.getItem(key);
const write = (key: string, value: string): void => window.localStorage.setItem(key, value);
