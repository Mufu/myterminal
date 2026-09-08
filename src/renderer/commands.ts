import type { AppState } from './app-state';
import type { MyTerminalApi } from '../shared/api';
import type {
  ICommand,
  ActiveTerminal,
  ClipboardPort,
  InputPanelPort,
  DialogPort,
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
