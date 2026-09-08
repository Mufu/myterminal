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

    this.unsubscribeTheme = theme.subscribe(() => {
      this.term.options.theme = THEMES[theme.get()].terminal;
    });
  }

  write(data: string): void {
    this.term.write(data);
  }

  show(): void {
    this.host.hidden = false;
    this.resize();
    this.term.focus();
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

  focus(): void {
    this.term.focus();
  }

  dispose(): void {
    this.unsubscribeTheme();
    this.term.dispose();
    this.host.remove();
  }
}
