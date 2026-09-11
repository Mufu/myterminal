import type { AppState } from './app-state';
import type { ThemeStore } from './theme';
import { parseTheme } from './theme';
import type { MyTerminalApi } from '../shared/api';
import type { ConnectionProfile, SavedProfile } from '../shared/profile';
import type { AgentKind } from '../shared/agent';
import type { SessionInfo } from '../shared/session';
import type {
  ICommand,
  ActiveTerminal,
  ClipboardPort,
  InputPanelPort,
  DialogPort,
  ConfirmPort,
} from './ports';

/**
 * 工具列的每個按鈕都是一個 Command 物件。
 * 按鈕只負責「按下去就 execute()」，行為本身不碰 DOM，可以單獨測試。
 */

/** 新連接 */
export class NewConnectionCommand implements ICommand {
  constructor(private readonly dialog: DialogPort) {}
  execute(): void {
    this.dialog.open();
  }
}

/** 輸入字 */
export class ToggleInputPanelCommand implements ICommand {
  constructor(private readonly state: AppState) {}
  execute(): void {
    this.state.toggleInputPanel();
  }
}

/** 複製文字 */
export class CopySelectionCommand implements ICommand {
  constructor(
    private readonly activeTerminal: ActiveTerminal,
    private readonly clipboard: ClipboardPort,
  ) {}
  async execute(): Promise<void> {
    const selection = this.activeTerminal()?.getSelection() ?? '';
    if (!selection) return;
    await this.clipboard.writeText(selection);
  }
}

/** 貼上 */
export class PasteCommand implements ICommand {
  constructor(
    private readonly state: AppState,
    private readonly api: MyTerminalApi,
    private readonly clipboard: ClipboardPort,
  ) {}
  async execute(): Promise<void> {
    const id = this.state.activeSessionId;
    if (!id) return;
    const text = await this.clipboard.readText();
    if (!text) return;
    await this.api.write(id, text);
  }
}

/** 紀錄 */
export class ToggleLogCommand implements ICommand {
  constructor(
    private readonly state: AppState,
    private readonly api: MyTerminalApi,
  ) {}
  async execute(): Promise<void> {
    const session = this.state.activeSession();
    if (!session) return;
    if (session.logging) await this.api.stopLog(session.id);
    else await this.api.startLog(session.id);
  }
}

/** 清除畫面 */
export class ClearScreenCommand implements ICommand {
  constructor(private readonly activeTerminal: ActiveTerminal) {}
  execute(): void {
    this.activeTerminal()?.clear();
  }
}

/** 輸入面板的「送出」：把整段內容一次送進工作階段。*/
export class SendInputCommand implements ICommand {
  constructor(
    private readonly state: AppState,
    private readonly api: MyTerminalApi,
    private readonly panel: InputPanelPort,
  ) {}
  async execute(): Promise<void> {
    const id = this.state.activeSessionId;
    if (!id) return;
    const text = this.panel.getText();
    if (!text.trim()) return;
    await this.api.write(id, `${text}\r`);
    this.panel.clear();
  }
}

/** 主題下拉選單：把選到的值交給 ThemeStore。*/
export class SwitchThemeCommand implements ICommand {
  constructor(
    private readonly theme: ThemeStore,
    private readonly selected: () => string,
  ) {}
  execute(): void {
    this.theme.set(parseTheme(this.selected()));
  }
}

/** 點一下已儲存的連線：用同一條建立工作階段的流程連上去。*/
export class ConnectFromProfileCommand implements ICommand {
  constructor(
    private readonly connect: (profile: ConnectionProfile) => void,
    private readonly profile: SavedProfile,
  ) {}
  execute(): void {
    this.connect(this.profile);
  }
}

/** 在真的終端機裡接續同一段對話的指令。*/
export function resumeCommand(kind: AgentKind, sessionId: string): string {
  return kind === 'claude' ? `claude --resume ${sessionId}` : `codex resume ${sessionId}`;
}

/**
 * 「接手」：把跑完的 agent 任務接到一個真的互動式工作階段裡。
 * 走的是既有的 Claude / Codex 型別 (PowerShell 起 shell 再送啟動指令)，
 * 所以接手之後跟平常自己開 claude 沒有兩樣。
 */
export class TakeOverCommand implements ICommand {
  constructor(
    private readonly connect: (profile: ConnectionProfile) => void,
    private readonly session: SessionInfo,
  ) {}

  execute(): void {
    const { agentKind, agentSessionId } = this.session;
    if (!agentKind || !agentSessionId) return;
    this.connect({
      type: agentKind,
      name: `接手 ${this.session.name}`,
      cwd: this.session.cwd,
      baseShell: 'powershell',
      startupCommand: resumeCommand(agentKind, agentSessionId),
    });
  }
}

/** 「執行範本」對話框按下開始：把範本與參數交給 main，之後全部走 workflow:changed。*/
export class StartWorkflowCommand implements ICommand {
  constructor(
    private readonly api: MyTerminalApi,
    private readonly templateId: string,
    private readonly params: Record<string, string>,
  ) {}
  async execute(): Promise<void> {
    await this.api.startWorkflow(this.templateId, this.params);
  }
}

/** 批准／退回：等待批准的執行從中斷的地方接下去。*/
export class ResumeWorkflowCommand implements ICommand {
  constructor(
    private readonly api: MyTerminalApi,
    private readonly runId: string,
    private readonly approved: boolean,
  ) {}
  async execute(): Promise<void> {
    await this.api.resumeWorkflow(this.runId, this.approved);
  }
}

/** 取消執行中的工作流：會砍掉正在跑的 CLI，所以先問一次。*/
export class CancelWorkflowCommand implements ICommand {
  constructor(
    private readonly api: MyTerminalApi,
    private readonly confirm: ConfirmPort,
    private readonly run: { runId: string; name: string },
  ) {}
  async execute(): Promise<void> {
    if (!this.confirm(`取消工作流「${this.run.name}」？`)) return;
    await this.api.cancelWorkflow(this.run.runId);
  }
}

/** 已儲存連線的 ✕：確認之後才刪除。*/
export class RemoveProfileCommand implements ICommand {
  constructor(
    private readonly api: MyTerminalApi,
    private readonly confirm: ConfirmPort,
    private readonly name: string,
  ) {}
  async execute(): Promise<void> {
    if (!this.confirm(`刪除連線設定「${this.name}」？`)) return;
    await this.api.removeProfile(this.name);
  }
}
