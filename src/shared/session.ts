import type { SessionType } from './profile';
import type { AgentKind } from './agent';

export type SessionState = 'running' | 'exited';

/** 送到 renderer 的工作階段摘要 (不含 pty 物件)。*/
export interface SessionInfo {
  id: string;
  name: string;
  type: SessionType;
  state: SessionState;
  /** 是否正在記錄輸出到檔案。*/
  logging: boolean;
  /** state === 'exited' 時的離開碼。*/
  exitCode?: number;
  /** 建立時指定的工作目錄；agent 任務會是已經套過預設值的那一個。*/
  cwd?: string;
  /** type === 'agent' 時，這次任務跑的是哪個 CLI。*/
  agentKind?: AgentKind;
  /** CLI 回報的 session_id / thread_id，有了才能「接手」。*/
  agentSessionId?: string;
}
