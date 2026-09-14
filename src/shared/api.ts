import type { ConnectionProfile, SavedProfile } from './profile';
import type { SessionInfo } from './session';
import type { DataEvent, ExitEvent } from './ipc';
import type { RunState, WorkflowDefinition, WorkflowInfo } from './workflow';

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

  listProfiles(): Promise<SavedProfile[]>;
  saveProfile(profile: SavedProfile): Promise<void>;
  removeProfile(name: string): Promise<void>;

  listWorkflows(): Promise<WorkflowInfo[]>;
  getWorkflow(id: string): Promise<WorkflowDefinition | undefined>;
  /** 不合法的定義會以驗證訊息 reject。*/
  saveWorkflow(definition: WorkflowDefinition): Promise<void>;
  deleteWorkflow(id: string): Promise<void>;
  startWorkflow(workflowId: string, params: Record<string, string>): Promise<string>;
  resumeWorkflow(runId: string, approved: boolean): Promise<void>;
  cancelWorkflow(runId: string): Promise<void>;
  workflowRuns(): Promise<RunState[]>;

  onData(listener: (event: DataEvent) => void): void;
  onExit(listener: (event: ExitEvent) => void): void;
  onSessionsChanged(listener: (sessions: SessionInfo[]) => void): void;
  onProfilesChanged(listener: (profiles: SavedProfile[]) => void): void;
  onWorkflowChanged(listener: (runs: RunState[]) => void): void;
}

declare global {
  interface Window {
    myterminal: MyTerminalApi;
  }
}
