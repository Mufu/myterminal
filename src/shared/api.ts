import type { ConnectionProfile } from './profile';
import type { SessionInfo } from './session';
import type { DataEvent, ExitEvent } from './ipc';

/**
 * preload 透過 contextBridge 暴露到 window.myterminal 的介面。
 * main / preload / renderer / 測試都以這份型別為準。
 */
export interface MyTerminalApi {
  createSession(profile: ConnectionProfile, cols: number, rows: number): Promise<SessionInfo>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  close(id: string): Promise<void>;
  list(): Promise<SessionInfo[]>;
  startLog(id: string): Promise<string>;
  stopLog(id: string): Promise<void>;

  onData(listener: (event: DataEvent) => void): void;
  onExit(listener: (event: ExitEvent) => void): void;
  onSessionsChanged(listener: (sessions: SessionInfo[]) => void): void;
}

declare global {
  interface Window {
    myterminal: MyTerminalApi;
  }
}
