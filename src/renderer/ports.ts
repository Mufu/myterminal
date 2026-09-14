/**
 * Command 需要的最小介面 (Port)。
 * 正式環境由 xterm.js / navigator.clipboard / <dialog> / <textarea> 實作，
 * 測試則注入假物件，因此工具列行為完全可以離開瀏覽器被驗證。
 */

export interface ICommand {
  execute(): void | Promise<void>;
}

export interface TerminalPort {
  getSelection(): string;
  clear(): void;
  focus(): void;
  /**
   * 貼上一段文字：xterm 會把 \r\n / \n 歸一化成 \r，
   * 對方開了 bracketed paste (模式 2004) 時還會加上貼上標記，
   * 所以多行貼上是一整段進去，不是一個一個按鍵。
   */
  paste(text: string): void;
}

export interface ClipboardPort {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface InputPanelPort {
  getText(): string;
  clear(): void;
}

export interface DialogPort {
  open(): void;
}

/** 刪除前的確認；正式環境是 window.confirm，測試直接回傳 true / false。*/
export type ConfirmPort = (message: string) => boolean;

/** 取得目前作用中的終端機；沒有工作階段時是 null。*/
export type ActiveTerminal = () => TerminalPort | null;
