/**
 * Agent 任務 (spike)：把 claude / codex 的無介面模式當成一次性的工作來跑。
 * 純資料 + 事件型別，main 與 renderer 共用。
 */

export type AgentKind = 'claude' | 'codex';

export interface AgentTask {
  kind: AgentKind;
  /** 要交給 CLI 的提示；一律走 stdin，避免 Windows 的命令列引號問題。*/
  prompt: string;
  cwd: string;
  /** false 時用最嚴格但仍會回答的模式 (claude plan / codex read-only)。*/
  allowEdits: boolean;
  /** 接續前一次對話：claude 的 session_id 或 codex 的 thread_id。*/
  resumeId?: string;
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
