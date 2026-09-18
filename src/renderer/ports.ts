import type { RoleInfo } from '../shared/roles';

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
  /** 填好一段文字等人自己按送出 (畫布上的「開終端機並啟動」用)。*/
  setText(text: string): void;
  /** 送出成功了；要清空還是留著由面板自己決定 (「送出後保留」)。*/
  sent(): void;
}

export interface DialogPort {
  open(): void;
}

/**
 * 角色選擇器：開起來，使用者挑一個就把它交回來 (取消就不呼叫)。
 * 「清除」是欄位自己那顆按鈕的事，所以這裡不會回 null。
 */
export interface RolePickerPort {
  open(currentId: string | undefined, onPick: (role: RoleInfo) => void): void;
}

/**
 * 「助理」面板：Command 只需要拿到問題、開一輪問答、把失敗寫出來、清掉對話。
 * 答案本身是 main 推過來的事件，面板自己接，不經過 Command。
 */
export interface AssistantPort {
  /** 輸入框現在的字。*/
  question(): string;
  /** 開一輪：清空輸入框、加一顆使用者泡泡、備好一顆等著接答案的助理泡泡。*/
  start(question: string): void;
  /** 這一輪失敗了 (沒登入、上一個還在回答、IPC 壞了)。*/
  fail(message: string): void;
  /** 「新對話」：畫面上的訊息全部清掉。*/
  clear(): void;
}

/** 刪除前的確認；正式環境是 window.confirm，測試直接回傳 true / false。*/
export type ConfirmPort = (message: string) => boolean;

/** 取得目前作用中的終端機；沒有工作階段時是 null。*/
export type ActiveTerminal = () => TerminalPort | null;
