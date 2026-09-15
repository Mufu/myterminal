/**
 * Agent 任務 (spike)：把四支 CLI 的無介面模式當成一次性的工作來跑。
 * 純資料 + 事件型別，main 與 renderer 共用。
 */

export type AgentKind = 'claude' | 'codex' | 'muse' | 'opencode';

export interface AgentTask {
  kind: AgentKind;
  /** 要交給 CLI 的提示；走 stdin 或暫存檔，不放命令列，避免 Windows 的引號問題。*/
  prompt: string;
  cwd: string;
  /**
   * false 時用最嚴格但仍會回答的模式：claude plan / codex read-only /
   * muse untrusted + --disable-write / opencode 的 plan agent。
   */
  allowEdits: boolean;
  /** 接續前一次對話：各家的 session_id / thread_id。*/
  resumeId?: string;
  /** 角色的前置指示。*/
  systemPrompt?: string;
}

/** CLI 的 JSONL 事件正規化之後的樣子。*/
export type AgentEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | {
      type: 'result';
      ok: boolean;
      text: string;
      sessionId?: string;
      durationMs?: number;
      costUsd?: number;
      exitCode: number;
    }
  | { type: 'error'; message: string };
