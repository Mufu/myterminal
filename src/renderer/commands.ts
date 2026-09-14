import type { AppState } from './app-state';
import type { ThemeStore } from './theme';
import { parseTheme } from './theme';
import type { WorkflowEditorModel } from './workflow-editor-model';
import { newWorkflowId } from './workflow-editor-model';
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

/** 「執行工作流」對話框按下開始：把工作流與參數交給 main，之後全部走 workflow:changed。*/
export class StartWorkflowCommand implements ICommand {
  constructor(
    private readonly api: MyTerminalApi,
    private readonly workflowId: string,
    private readonly params: Record<string, string>,
  ) {}
  async execute(): Promise<void> {
    await this.api.startWorkflow(this.workflowId, this.params);
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

/**
 * 「編輯」：打開畫布。手上還有沒存的東西就直接顯示，不要把它蓋掉。
 */
export class OpenEditorCommand implements ICommand {
  constructor(
    private readonly state: AppState,
    private readonly model: WorkflowEditorModel,
  ) {}
  execute(): void {
    if (!this.model.dirty) this.model.newWorkflow();
    this.state.showEditor();
  }
}

/** 「← 回終端機」：畫布上的東西留著，只是不顯示。*/
export class CloseEditorCommand implements ICommand {
  constructor(private readonly state: AppState) {}
  execute(): void {
    this.state.showTerminal();
  }
}

/**
 * 畫布的「儲存」：先在本地驗證一次 (錯誤直接顯示在畫布上，不用等 main 拒絕)，
 * 內建範本一律另存成副本 —— main 那邊本來就不讓覆蓋，與其被拒絕不如直接給副本。
 */
export class SaveWorkflowCommand implements ICommand {
  constructor(
    private readonly api: MyTerminalApi,
    private readonly model: WorkflowEditorModel,
    private readonly showErrors: (messages: string[]) => void,
    private readonly refresh: () => void | Promise<void>,
  ) {}

  async execute(): Promise<void> {
    await this.run();
  }

  /** 回傳有沒有真的存進去；「儲存並執行」要靠它決定要不要開對話框。*/
  async run(): Promise<boolean> {
    const errors = this.model.validate();
    if (errors.length > 0) {
      this.showErrors(errors);
      return false;
    }

    const current = this.model.definition;
    const copy = this.model.source === 'builtin';
    const definition = copy
      ? { ...current, id: newWorkflowId(), name: `${current.name} (副本)` }
      : current;

    try {
      await this.api.saveWorkflow(definition);
    } catch (error) {
      this.showErrors([errorText(error)]);
      return false;
    }

    // 存成副本之後，接下來編輯的就是那份副本。
    if (copy) this.model.load(definition, 'custom');
    else this.model.markSaved();
    this.showErrors([]);
    await this.refresh();
    return true;
  }
}

/** 畫布的「刪除」：只有自訂工作流刪得掉，刪完畫布回到一張新的。*/
export class DeleteWorkflowCommand implements ICommand {
  constructor(
    private readonly api: MyTerminalApi,
    private readonly confirm: ConfirmPort,
    private readonly model: WorkflowEditorModel,
    private readonly refresh: () => void | Promise<void>,
  ) {}
  async execute(): Promise<void> {
    const { id, name } = this.model.definition;
    if (!this.confirm(`刪除工作流「${name}」？`)) return;
    await this.api.deleteWorkflow(id);
    this.model.newWorkflow();
    await this.refresh();
  }
}

/** 「儲存並執行」：存起來，再用既有的執行對話框跑它。*/
export class SaveAndRunWorkflowCommand implements ICommand {
  constructor(
    private readonly save: SaveWorkflowCommand,
    private readonly model: WorkflowEditorModel,
    private readonly openRun: (workflowId: string) => void,
  ) {}
  async execute(): Promise<void> {
    if (!(await this.save.run())) return;
    this.openRun(this.model.definition.id);
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

/** IPC 丟回來的通常是 Error，但也可能是別的東西。*/
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
