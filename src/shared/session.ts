import type { SessionType } from './profile';

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
}
