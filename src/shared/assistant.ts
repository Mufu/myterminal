/**
 * 「助理」：app 內建的問答。它只回答關於 myterminal 怎麼用的問題，
 * 不執行任何工具、也不會動到工作階段，所以事件只有「又有一段字」與「講完了」。
 */
export type AssistantEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; sessionId?: string; costUsd?: number; durationMs?: number }
  | { type: 'error'; message: string };

/** 助理用的型號；畫面上的標題也寫這個。*/
export const ASSISTANT_MODEL = 'sonnet';
