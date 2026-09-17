import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalPort } from './ports';
import { THEMES } from './theme';
import type { ThemeStore } from './theme';

export interface TerminalHandlers {
  onInput(data: string): void;
  onResize(cols: number, rows: number): void;
}

/**
 * TerminalView：一個工作階段對應一個 xterm.js Terminal。
 * 只有作用中的那個容器顯示，其餘 hidden —— 沒有分割視窗。
 *
 * 建構時不需要 sessionId：id 要等 main 建好工作階段才會有，
 * 但終端機必須先存在才量得到 cols/rows。輸入與尺寸改變透過 handlers 回呼出去。
 * 同時實作 TerminalPort，讓工具列的 Command 不必知道 xterm.js。
 */
export class TerminalView implements TerminalPort {
  private readonly host: HTMLDivElement;
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly unsubscribeTheme: () => void;

  constructor(parent: HTMLElement, handlers: TerminalHandlers, theme: ThemeStore) {
    this.host = document.createElement('div');
    this.host.className = 'term-host';
    parent.appendChild(this.host);

    this.term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, "Microsoft JhengHei", monospace',
      fontSize: 13.5,
      cursorBlink: true,
      scrollback: 5000,
      // xterm 畫的是 canvas，吃不到 CSS 變數，顏色只能用 JS 給。
      theme: THEMES[theme.get()].terminal,
    });
    this.term.loadAddon(this.fit);
    this.term.open(this.host);
    this.fit.fit();

    this.term.onData(handlers.onInput);
    this.term.onResize(({ cols, rows }) => handlers.onResize(cols, rows));

    // capture：要在 xterm 自己的 compositionstart 之前跑，見 syncTextAreaToCursor()。
    this.host.addEventListener('compositionstart', () => this.syncTextAreaToCursor(), true);

    this.unsubscribeTheme = theme.subscribe(() => {
      this.term.options.theme = THEMES[theme.get()].terminal;
    });
  }

  write(data: string): void {
    this.term.write(data);
  }

  /**
   * 顯示出來，但「不」搶焦點：syncTerminals() 每次狀態變動都會呼叫到這裡，
   * 搶過來會打斷使用者正在別處打的字 (輸入字面板、以及 IME 正在組的字)。
   * 真的要換焦點的時候由呼叫端自己呼叫 focus()。
   */
  show(): void {
    this.host.hidden = false;
    this.resize();
  }

  hide(): void {
    this.host.hidden = true;
  }

  /** 重新量測容器並讓 xterm 觸發 onResize 同步給 pty。*/
  resize(): void {
    if (this.host.hidden || this.host.clientWidth === 0) return;
    this.fit.fit();
  }

  /** 目前的字元尺寸；建立工作階段時要先告訴 main。*/
  get dimensions(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  getSelection(): string {
    return this.term.getSelection();
  }

  clear(): void {
    this.term.clear();
  }

  /** 交給 xterm 的貼上路徑：換行歸一化與 bracketed paste 都由它處理。*/
  paste(text: string): void {
    this.term.paste(text);
  }

  focus(): void {
    this.term.focus();
  }

  /**
   * 開始組字時把 xterm 那個隱藏的輸入區搬回游標那一格 ——
   * Windows 的 TSF 候選字視窗就是貼著它出現的。
   *
   * xterm 自己的 _syncTextArea() 在組字期間會直接 return
   * (upstream xterm.js #5734、修正在 PR #5759)，所以重畫還在路上時開始組字，
   * 輸入區就停在舊座標，候選字視窗跟著跑掉。這裡在 xterm 的處理之前補一次。
   *
   * 只用公開的 term.textarea 與畫出來的 DOM (.xterm-cursor 就是游標那一格)，
   * 差多少補多少，不必知道 xterm 把座標算在哪個原點上，也不碰它的內部欄位 ——
   * 小版本升級時最多是選不到元素，那就什麼都不做。這只是補償，不可以丟例外。
   */
  private syncTextAreaToCursor(): void {
    try {
      const textarea = this.term.textarea;
      const cursor = this.host.querySelector('.xterm-cursor');
      if (!textarea || !cursor) return;

      const style = getComputedStyle(textarea);
      const left = Number.parseFloat(style.left);
      const top = Number.parseFloat(style.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return;

      const now = textarea.getBoundingClientRect();
      const target = cursor.getBoundingClientRect();
      textarea.style.left = `${left + (target.left - now.left)}px`;
      textarea.style.top = `${top + (target.top - now.top)}px`;
    } catch {
      // 位置沒調到就算了，組字本身不受影響。
    }
  }

  dispose(): void {
    this.unsubscribeTheme();
    this.term.dispose();
    this.host.remove();
  }
}
