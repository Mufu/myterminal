import type { ConnectionProfile } from './profile';
import type { ApiProvider, AuthMode, CliId } from './cli-auth';

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
  listProfiles: 'profiles:list',
  saveProfile: 'profiles:save',
  removeProfile: 'profiles:remove',
  listWorkflows: 'workflow:list',
  getWorkflow: 'workflow:get',
  saveWorkflow: 'workflow:save',
  deleteWorkflow: 'workflow:delete',
  startWorkflow: 'workflow:start',
  resumeWorkflow: 'workflow:resume',
  cancelWorkflow: 'workflow:cancel',
  workflowRuns: 'workflow:runs',
  cliAuth: 'cli:auth',
  cliRefresh: 'cli:refresh',
  cliSettings: 'cli:settings',
  saveCliSetting: 'cli:save-setting',
  clearCliKey: 'cli:clear-key',
  cliLogin: 'cli:login',

  /** main -> renderer (send) */
  data: 'session:data',
  exit: 'session:exit',
  sessionsChanged: 'session:changed',
  profilesChanged: 'profiles:changed',
  workflowChanged: 'workflow:changed',
  cliAuthChanged: 'cli:auth-changed',
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

export interface StartWorkflowRequest {
  workflowId: string;
  /** 工作流的啟動參數，樣板裡用 {{params.x}} 取用。*/
  params: Record<string, string>;
  /** 這次執行的用量上限 (估算美元)；沒填就是不限制。*/
  maxTotalCostUsd?: number;
}

export interface ResumeWorkflowRequest {
  runId: string;
  approved: boolean;
}

/** 存一支 CLI 的登入方式。apiKey 留空代表沿用已經存著的那一把。*/
export interface SaveCliSettingRequest {
  id: CliId;
  mode: AuthMode;
  apiKey?: string;
  provider?: ApiProvider;
  model?: string;
}
