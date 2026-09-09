import type { AgentKind } from './agent';

/**
 * 連線設定檔 (ConnectionProfile)：純資料，沒有任何行為。
 * 以 `type` 作為判別聯集 (discriminated union) 的判別欄位，
 * 讓 ShellFactory 可以用 exhaustive switch 產生 spawn 規格。
 */

export type SessionType =
  | 'powershell'
  | 'wsl'
  | 'ssh'
  | 'claude'
  | 'codex'
  | 'custom'
  | 'agent';

/** Claude / Codex 這類 agent 工作階段所依附的基礎 shell。*/
export type BaseShell = 'powershell' | 'wsl';

interface ProfileBase {
  /** 顯示名稱；留空時由 SessionManager 自動產生 (例如 "PowerShell 1")。*/
  name?: string;
  /** 工作目錄；留空時使用 Electron 行程的預設目錄。*/
  cwd?: string;
}

export interface PowerShellProfile extends ProfileBase {
  type: 'powershell';
}

export interface WslProfile extends ProfileBase {
  type: 'wsl';
  /** WSL 發行版名稱，例如 "Ubuntu"。留空代表預設發行版。*/
  distro?: string;
}

export interface SshProfile extends ProfileBase {
  type: 'ssh';
  host: string;
  port?: number;
  user: string;
}

export interface AgentProfile extends ProfileBase {
  type: 'claude' | 'codex';
  /** 要在哪個 shell 裡執行 agent。*/
  baseShell: BaseShell;
  /** spawn 之後立刻寫進 pty 的啟動指令，預設是 "claude" / "codex"，使用者可改。*/
  startupCommand?: string;
}

/**
 * Agent 任務 (spike)：不是開一個 shell，而是把 claude / codex 的無介面模式
 * 跑一次。不經過 ShellFactory，由 SessionManager 交給 IAgentRunner。
 */
export interface AgentTaskProfile extends ProfileBase {
  type: 'agent';
  kind: AgentKind;
  prompt: string;
  /** 預設 false：不讓 agent 改檔案。*/
  allowEdits: boolean;
}

export interface CustomProfile extends ProfileBase {
  type: 'custom';
  file: string;
  args?: string[];
}

export type ConnectionProfile =
  | PowerShellProfile
  | WslProfile
  | SshProfile
  | AgentProfile
  | AgentTaskProfile
  | CustomProfile;

/** 已儲存的連線設定：名稱是必填的，因為清單與刪除都以名稱為鍵。*/
export type SavedProfile = ConnectionProfile & { name: string };

/** 每個型別的預設顯示前綴，供 SessionManager 產生名稱時使用。*/
export const TYPE_LABELS: Record<SessionType, string> = {
  powershell: 'PowerShell',
  wsl: 'WSL',
  ssh: 'SSH',
  claude: 'Claude',
  codex: 'Codex',
  custom: '自訂',
  agent: 'Agent',
};

export const DEFAULT_SSH_PORT = 22;

export function defaultStartupCommand(type: 'claude' | 'codex'): string {
  return type;
}
