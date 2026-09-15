import type { AppState } from './app-state';
import type { ThemeStore } from './theme';
import { parseTheme } from './theme';
import type { WorkflowEditorModel } from './workflow-editor-model';
import { newWorkflowId } from './workflow-editor-model';
import type { MyTerminalApi } from '../shared/api';
import type { ConnectionProfile, SavedProfile } from '../shared/profile';
import type { AgentKind } from '../shared/agent';
import type { CliAuthSetting, CliId } from '../shared/cli-auth';
import { validateCliSetting } from '../shared/cli-auth';
import type { SaveCliSettingRequest } from '../shared/ipc';
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

/**
 * 貼上：走 xterm 的貼上路徑，不要自己把字丟進 pty ——
 * 換行會被歸一化成 CR，對方開了 bracketed paste 時整段是一次進去的，
 * 所以多行不會被 PSReadLine 拆成軟斷行，很大一段也不會一個字一個字重畫。
 */
export class PasteCommand implements ICommand {
  constructor(
    private readonly activeTerminal: ActiveTerminal,
    private readonly clipboard: ClipboardPort,
  ) {}
  async execute(): Promise<void> {
    const terminal = this.activeTerminal();
    if (!terminal) return;
    const text = await this.clipboard.readText();
    if (!text) return;
    terminal.paste(text);
  }
}

/** 紀錄。已經結束的工作階段不會再有輸出，開紀錄只會留下一個 0 byte 的檔案。*/
export class ToggleLogCommand implements ICommand {
  constructor(
    private readonly state: AppState,
    private readonly api: MyTerminalApi,
  ) {}
  async execute(): Promise<void> {
    const session = this.state.activeSession();
    if (!session) return;
    if (session.logging) await this.api.stopLog(session.id);
    else if (session.state === 'running') await this.api.startLog(session.id);
  }
}

/** 清除畫面 */
export class ClearScreenCommand implements ICommand {
  constructor(private readonly activeTerminal: ActiveTerminal) {}
  execute(): void {
    this.activeTerminal()?.clear();
  }
}

/**
 * 輸入面板的「送出」：整段內容走跟「貼上」同一條 xterm 貼上路徑，
 * 再補一個 CR 送出。shell 收到的是一段多行緩衝區，按下 Enter 才一次執行；
 * Claude / Codex 的 TUI 也是一樣，貼上不會提早送出。
 */
export class SendInputCommand implements ICommand {
  constructor(
    private readonly state: AppState,
    private readonly api: MyTerminalApi,
    private readonly panel: InputPanelPort,
    private readonly activeTerminal: ActiveTerminal,
  ) {}
  async execute(): Promise<void> {
    const id = this.state.activeSessionId;
    const terminal = this.activeTerminal();
    if (!id || !terminal) return;
    const text = this.panel.getText();
    if (!text.trim()) return;
    terminal.paste(text);
    await this.api.write(id, '\r');
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

/** 在真的終端機裡接續同一段對話的指令。四支 CLI 都有自己的形式。*/
export function resumeCommand(kind: AgentKind, sessionId: string): string {
  switch (kind) {
    case 'claude':
      return `claude --resume ${sessionId}`;
    case 'codex':
      return `codex resume ${sessionId}`;
    case 'muse':
      return `muse resume ${sessionId}`;
    // opencode 沒有 resume 子命令，TUI 是用 --session 開回同一段對話。
    case 'opencode':
      return `opencode --session ${sessionId}`;
  }
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

/**
 * 點畫布卡片上的「輸出」：切回終端機畫面並顯示那個節點的工作階段。
 * 右側清單那一列不必切畫面 (它本來就在終端機那一側)，所以只有畫布用它。
 */
export class SelectSessionCommand implements ICommand {
  constructor(
    private readonly state: AppState,
    private readonly sessionId: string,
  ) {}
  execute(): void {
    this.state.showTerminal();
    this.state.setActive(this.sessionId);
  }
}

/** 「執行工作流」對話框按下開始：把工作流與參數交給 main，之後全部走 workflow:changed。*/
export class StartWorkflowCommand implements ICommand {
  constructor(
    private readonly api: MyTerminalApi,
    private readonly workflowId: string,
    private readonly params: Record<string, string>,
    /** 留空就是不限制這次執行的用量。*/
    private readonly maxTotalCostUsd?: number,
  ) {}
  async execute(): Promise<void> {
    await this.api.startWorkflow(this.workflowId, this.params, this.maxTotalCostUsd);
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

/** 「CLI 設定」：頁尾的晶片或 ⚙ 按下去就開對話框。*/
export class OpenCliSettingsCommand implements ICommand {
  constructor(private readonly dialog: DialogPort) {}
  execute(): void {
    this.dialog.open();
  }
}

/** 存一支 CLI 的登入方式。先在本地驗一次，不用等 main 拒絕才顯示原因。*/
export class SaveCliSettingCommand implements ICommand {
  constructor(
    private readonly api: MyTerminalApi,
    private readonly request: SaveCliSettingRequest,
    /** 已經存過金鑰的話就不必重打。*/
    private readonly hasKey: boolean,
    private readonly onSaved: (settings: Record<CliId, CliAuthSetting>) => void,
    private readonly showErrors: (messages: string[]) => void,
  ) {}

  async execute(): Promise<void> {
    const errors = validateCliSetting(this.request, this.hasKey);
    if (errors.length > 0) {
      this.showErrors(errors);
      return;
    }
    try {
      this.onSaved(await this.api.saveCliSetting(this.request));
      this.showErrors([]);
    } catch (error) {
      this.showErrors([errorText(error)]);
    }
  }
}

/** 清除金鑰：登入方式留著，那一支 CLI 回到自己原本的登入狀態。*/
export class ClearCliKeyCommand implements ICommand {
  constructor(
    private readonly api: MyTerminalApi,
    private readonly id: CliId,
    private readonly onCleared: (settings: Record<CliId, CliAuthSetting>) => void,
    private readonly showErrors: (messages: string[]) => void,
  ) {}

  async execute(): Promise<void> {
    try {
      this.onCleared(await this.api.clearCliKey(this.id));
      this.showErrors([]);
    } catch (error) {
      this.showErrors([errorText(error)]);
    }
  }
}

/**
 * 「登入」：開一個跑登入指令的工作階段，瀏覽器那一段由使用者自己走完。
 * 工作階段結束時 main 會重探登入狀態，晶片上的字跟著換。
 */
export class LoginCliCommand implements ICommand {
  constructor(
    private readonly api: MyTerminalApi,
    private readonly id: CliId,
    private readonly onStarted: (sessionId: string) => void | Promise<void>,
    private readonly showErrors: (messages: string[]) => void,
  ) {}

  async execute(): Promise<void> {
    try {
      await this.onStarted(await this.api.cliLogin(this.id));
      this.showErrors([]);
    } catch (error) {
      this.showErrors([errorText(error)]);
    }
  }
}

/**
 * IPC 丟回來的通常是 Error，但也可能是別的東西。
 * Electron 還會把 main 丟的例外包成
 * `Error invoking remote method 'session:create': Error: <原因>`，
 * 使用者只需要看到最裡面那句原因。
 */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const unwrapped = raw.replace(/^Error invoking remote method '[^']*':\s*/, '');
  return unwrapped.replace(/^(?:Error:\s*)+/, '').trim() || raw;
}
