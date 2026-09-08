import type { ConnectionProfile } from './profile';

/**
 * IPC 契約：頻道名稱 + payload 型別集中在 shared，
 * main / preload / renderer 三邊共用同一份定義。
 */
export const IPC = {
  /** renderer -> main (invoke) */
  createSession: 'session:create',
  write: 'session:write',
  resize: 'session:resize',
  close: 'session:close',
  list: 'session:list',
  startLog: 'session:start-log',
  stopLog: 'session:stop-log',

  /** main -> renderer (send) */
  data: 'session:data',
  exit: 'session:exit',
  sessionsChanged: 'session:changed',
} as const;

export interface CreateSessionRequest {
  profile: ConnectionProfile;
  cols: number;
  rows: number;
}

export interface WriteRequest {
  id: string;
  data: string;
}

export interface ResizeRequest {
  id: string;
  cols: number;
  rows: number;
}

export interface DataEvent {
  id: string;
  data: string;
}

export interface ExitEvent {
  id: string;
  exitCode: number;
}

/** startLog 的回傳：實際寫入的檔案路徑。*/
export interface StartLogResult {
  path: string;
}
