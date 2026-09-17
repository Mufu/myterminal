/**
 * 「輸入字」面板的純邏輯：每個工作階段自己的送出歷史與還沒送出的草稿。
 * 只活在這一次執行的記憶體裡（關掉 app 就沒了），所以不碰 localStorage，
 * 整個模組也不需要 DOM 就測得完。
 */

/** 一個工作階段最多記幾筆送出過的內容。*/
export const MAX_HISTORY = 50;

interface SessionInput {
  /** 送出過的原文，最新的在最後。*/
  entries: string[];
  /**
   * entries 再加上「還沒送出的那一格」之後的可編輯副本。
   * 叫回舊的那一筆再打字，改的是這裡的副本，送出過的原文不會被動到。
   */
  lines: string[];
  /** lines 裡目前在編輯哪一格。*/
  index: number;
}

export class InputHistory {
  private readonly sessions = new Map<string, SessionInput>();

  /** 這個工作階段現在該顯示在輸入區裡的字。*/
  text(id: string): string {
    const input = this.sessions.get(id);
    return input ? input.lines[input.index] : '';
  }

  /** 使用者打字：改的是目前那一格的副本。*/
  setText(id: string, text: string): void {
    const input = this.of(id);
    input.lines[input.index] = text;
  }

  /** 送出：進歷史（最多 MAX_HISTORY 筆），游標回到最後那一格空白的。*/
  push(id: string, text: string): void {
    const input = this.of(id);
    input.entries.push(text);
    if (input.entries.length > MAX_HISTORY) {
      input.entries.splice(0, input.entries.length - MAX_HISTORY);
    }
    // 叫回舊訊息時改過的副本在送出之後一律丟掉，跟 shell 的歷史一樣。
    input.lines = [...input.entries, ''];
    input.index = input.entries.length;
  }

  /** ↑（step -1）往舊的、↓（step 1）往新的走一格；沒得走就回 null。*/
  recall(id: string, step: -1 | 1): string | null {
    const input = this.sessions.get(id);
    if (!input) return null;
    const next = input.index + step;
    if (next < 0 || next >= input.lines.length) return null;
    input.index = next;
    return input.lines[next];
  }

  private of(id: string): SessionInput {
    const found = this.sessions.get(id);
    if (found) return found;
    const created: SessionInput = { entries: [], lines: [''], index: 0 };
    this.sessions.set(id, created);
    return created;
  }
}

/**
 * 游標在第一行（前面沒有換行）。↑ 只有在這裡才叫回上一筆，
 * 不然它得留著在多行訊息裡往上移動 —— 輸入區本來就是拿來寫多行的。
 */
export function atFirstLine(value: string, caret: number): boolean {
  return !value.slice(0, caret).includes('\n');
}

/** 游標在最後一行；↓ 同理。*/
export function atLastLine(value: string, caret: number): boolean {
  return !value.slice(caret).includes('\n');
}
