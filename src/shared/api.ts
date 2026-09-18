import type { ConnectionProfile, SavedProfile } from './profile';
import type { SessionInfo } from './session';
import type { DataEvent, ExitEvent, RolesResult, SaveCliSettingRequest } from './ipc';
import type { RunState, WorkflowDefinition, WorkflowInfo } from './workflow';
import type { CliAuthSetting, CliAuthStatus, CliId } from './cli-auth';
import type { AssistantEvent } from './assistant';

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
  /** maxTotalCostUsd 留空就是不限制這次執行的用量。*/
  startWorkflow(
    workflowId: string,
    params: Record<string, string>,
    maxTotalCostUsd?: number,
  ): Promise<string>;
  resumeWorkflow(runId: string, approved: boolean): Promise<void>;
  cancelWorkflow(runId: string): Promise<void>;
  workflowRuns(): Promise<RunState[]>;

  /** 四支 CLI 實際的登入狀態；開機探測一次，登入流程跑完會再探一次。*/
  cliAuth(): Promise<CliAuthStatus>;
  /** 「重新偵測」：在外面的終端機登入 / 登出之後重探一次，不必重開 app。*/
  cliRefresh(): Promise<CliAuthStatus>;
  /** 使用者在「CLI 設定」裡選的登入方式；金鑰本身不會過來。*/
  cliSettings(): Promise<Record<CliId, CliAuthSetting>>;
  /** 存起來並回傳更新後的整份設定；驗證沒過會以訊息 reject。*/
  saveCliSetting(request: SaveCliSettingRequest): Promise<Record<CliId, CliAuthSetting>>;
  clearCliKey(id: CliId): Promise<Record<CliId, CliAuthSetting>>;
  /** 開一個跑登入指令的工作階段，回傳它的 id。*/
  cliLogin(id: CliId): Promise<string>;

  /** 角色清單 (內建 + 角色庫)；掃過的話回的是快取那一份。*/
  listRoles(): Promise<RolesResult>;
  /** 重新掃一次角色資料夾。*/
  rescanRoles(): Promise<RolesResult>;
  /** 換角色資料夾：存起來並重掃；目錄不存在會以訊息 reject。*/
  setRolesDir(dir: string): Promise<RolesResult>;
  /** 開原生的選資料夾對話框；使用者取消時回 null。*/
  pickRolesDir(): Promise<string | null>;

  /**
   * 問助理一句。答案走 onAssistantEvent 一段一段回來，
   * 這個 Promise 要等它講完 (或失敗) 才 resolve；沒登入或上一個還在回答會 reject。
   */
  askAssistant(question: string, context: string): Promise<void>;
  /** 「新對話」：忘掉上一段對話。*/
  resetAssistant(): Promise<void>;
  /** 回答到一半按「取消」。*/
  cancelAssistant(): Promise<void>;

  onData(listener: (event: DataEvent) => void): void;
  onExit(listener: (event: ExitEvent) => void): void;
  onSessionsChanged(listener: (sessions: SessionInfo[]) => void): void;
  onProfilesChanged(listener: (profiles: SavedProfile[]) => void): void;
  onWorkflowChanged(listener: (runs: RunState[]) => void): void;
  /** 登入流程跑完之後 main 重探的結果。*/
  onCliAuthChanged(listener: (status: CliAuthStatus) => void): void;
  /** 助理的回答：一段文字、講完了、或失敗。*/
  onAssistantEvent(listener: (event: AssistantEvent) => void): void;
}

declare global {
  interface Window {
    myterminal: MyTerminalApi;
  }
}
