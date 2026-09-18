/**
 * Agent 任務 (spike)：把四支 CLI 的無介面模式當成一次性的工作來跑。
 * 純資料 + 事件型別，main 與 renderer 共用。
 */

export type AgentKind = 'claude' | 'codex' | 'muse' | 'opencode';

/**
 * 給 CLI 多少權限。三檔，各家 CLI 的對應在 main/agent-runner.ts：
 *   - readonly：最嚴格但仍會回答的模式 (claude plan / codex read-only /
 *     muse untrusted + --disable-write / opencode 的 plan agent)。
 *   - edit：可以改檔案，但 claude 的 acceptEdits 仍會擋掉 Bash 指令 ——
 *     要跑測試的節點得用 full。
 *   - full：完全放行，任何指令都會直接執行。
 */
export type AgentPermission = 'readonly' | 'edit' | 'full';

export const PERMISSION_LABELS: Record<AgentPermission, string> = {
  readonly: '唯讀',
  edit: '可修改檔案',
  full: '完全放行（會執行任何指令）',
};

export const PERMISSIONS = Object.keys(PERMISSION_LABELS) as readonly AgentPermission[];

export function isAgentPermission(value: unknown): value is AgentPermission {
  return typeof value === 'string' && value in PERMISSION_LABELS;
}

/** 舊資料只有 allowEdits 兩檔：true 是可修改檔案，false 是唯讀。*/
export function permissionFromAllowEdits(allowEdits: boolean): AgentPermission {
  return allowEdits ? 'edit' : 'readonly';
}

/**
 * 讀進來的 JSON 可能是舊的 (只有 allowEdits)、新的 (permission)、或兩個都沒有。
 * 認不得的一律回 undefined，交給呼叫端決定要用哪個預設值。
 */
export function readPermission(raw: Record<string, unknown>): AgentPermission | undefined {
  if (isAgentPermission(raw.permission)) return raw.permission;
  if (typeof raw.allowEdits === 'boolean') return permissionFromAllowEdits(raw.allowEdits);
  return undefined;
}

/**
 * CLI 回報的 token 用量。`total` 用各家自己算的總數 —— 算法不一樣
 * (opencode 的 total 含快取讀寫)，在這裡重算只會跟它畫面上的數字對不起來。
 */
export interface TokenUsage {
  input?: number;
  output?: number;
  total: number;
}

/** token 數在畫面上的寫法：1000 以下照原樣，1000 以上縮成 12.3k。*/
export function formatTokens(total: number): string {
  return total < 1000 ? `${total}` : `${(total / 1000).toFixed(1)}k`;
}

export interface AgentTask {
  kind: AgentKind;
  /** 要交給 CLI 的提示；走 stdin 或暫存檔，不放命令列，避免 Windows 的引號問題。*/
  prompt: string;
  cwd: string;
  permission: AgentPermission;
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
      /** Codex 只回報這個，不回報金額。*/
      tokens?: TokenUsage;
      exitCode: number;
    }
  | { type: 'error'; message: string };
