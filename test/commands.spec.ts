import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppState } from '../src/renderer/app-state';
import {
  NewConnectionCommand,
  ToggleInputPanelCommand,
  CopySelectionCommand,
  PasteCommand,
  ToggleLogCommand,
  ClearScreenCommand,
  SendInputCommand,
} from '../src/renderer/commands';
import type { TerminalPort, ClipboardPort, InputPanelPort, DialogPort } from '../src/renderer/ports';
import type { MyTerminalApi } from '../src/shared/api';
import type { SessionInfo } from '../src/shared/session';

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  name: id.toUpperCase(),
  type: 'powershell',
  state: 'running',
  logging: false,
  ...over,
});

class FakeTerminal implements TerminalPort {
  selection = '';
  cleared = 0;
  focused = 0;
  getSelection(): string {
    return this.selection;
  }
  clear(): void {
    this.cleared += 1;
  }
  focus(): void {
    this.focused += 1;
  }
}

class FakeClipboard implements ClipboardPort {
  text = '';
  written: string[] = [];
  async readText(): Promise<string> {
    return this.text;
  }
  async writeText(text: string): Promise<void> {
    this.written.push(text);
  }
}

class FakeInputPanel implements InputPanelPort {
  text = '';
  cleared = 0;
  getText(): string {
    return this.text;
  }
  clear(): void {
    this.cleared += 1;
  }
}

const fakeApi = () =>
  ({
    write: vi.fn().mockResolvedValue(undefined),
    startLog: vi.fn().mockResolvedValue('D:/logs/a.log'),
    stopLog: vi.fn().mockResolvedValue(undefined),
  }) as unknown as MyTerminalApi & {
    write: ReturnType<typeof vi.fn>;
    startLog: ReturnType<typeof vi.fn>;
    stopLog: ReturnType<typeof vi.fn>;
  };

let state: AppState;
let terminal: FakeTerminal;
let clipboard: FakeClipboard;
let api: ReturnType<typeof fakeApi>;
const activeTerminal = () => terminal;

beforeEach(() => {
  state = new AppState();
  terminal = new FakeTerminal();
  clipboard = new FakeClipboard();
  api = fakeApi();
  state.setSessions([session('s1')]);
});

describe('新連接', () => {
  it('打開對話框', () => {
    let opened = 0;
    const dialog: DialogPort = { open: () => (opened += 1) };
    new NewConnectionCommand(dialog).execute();
    expect(opened).toBe(1);
  });
});

describe('輸入字', () => {
  it('切換輸入面板顯示', () => {
    new ToggleInputPanelCommand(state).execute();
    expect(state.inputPanelVisible).toBe(true);
  });
});

describe('複製文字', () => {
  it('把終端機選取的文字寫進剪貼簿', async () => {
    terminal.selection = 'hello';
    await new CopySelectionCommand(activeTerminal, clipboard).execute();
    expect(clipboard.written).toEqual(['hello']);
  });

  it('沒有選取時不動剪貼簿', async () => {
    terminal.selection = '';
    await new CopySelectionCommand(activeTerminal, clipboard).execute();
    expect(clipboard.written).toEqual([]);
  });

  it('沒有作用中的終端機時安全略過', async () => {
    await new CopySelectionCommand(() => null, clipboard).execute();
    expect(clipboard.written).toEqual([]);
  });
});

describe('貼上', () => {
  it('把剪貼簿內容寫進作用中的工作階段', async () => {
    clipboard.text = 'npm test';
    await new PasteCommand(state, api, clipboard).execute();
    expect(api.write).toHaveBeenCalledWith('s1', 'npm test');
  });

  it('剪貼簿是空的就不寫', async () => {
    clipboard.text = '';
    await new PasteCommand(state, api, clipboard).execute();
    expect(api.write).not.toHaveBeenCalled();
  });

  it('沒有作用中的工作階段就不寫', async () => {
    state.setSessions([]);
    clipboard.text = 'x';
    await new PasteCommand(state, api, clipboard).execute();
    expect(api.write).not.toHaveBeenCalled();
  });
});

describe('紀錄', () => {
  it('未記錄時開始記錄', async () => {
    await new ToggleLogCommand(state, api).execute();
    expect(api.startLog).toHaveBeenCalledWith('s1');
    expect(api.stopLog).not.toHaveBeenCalled();
  });

  it('已在記錄時停止記錄', async () => {
    state.setSessions([session('s1', { logging: true })]);
    await new ToggleLogCommand(state, api).execute();
    expect(api.stopLog).toHaveBeenCalledWith('s1');
    expect(api.startLog).not.toHaveBeenCalled();
  });

  it('沒有作用中的工作階段時什麼都不做', async () => {
    state.setSessions([]);
    await new ToggleLogCommand(state, api).execute();
    expect(api.startLog).not.toHaveBeenCalled();
  });
});

describe('清除畫面', () => {
  it('清空終端機', () => {
    new ClearScreenCommand(activeTerminal).execute();
    expect(terminal.cleared).toBe(1);
  });

  it('沒有作用中的終端機時安全略過', () => {
    expect(() => new ClearScreenCommand(() => null).execute()).not.toThrow();
  });
});

describe('送出 (輸入面板)', () => {
  it('把整段文字加上換行送進工作階段，並清空輸入框', async () => {
    const panel = new FakeInputPanel();
    panel.text = '請幫我重構這段程式';
    await new SendInputCommand(state, api, panel).execute();
    expect(api.write).toHaveBeenCalledWith('s1', '請幫我重構這段程式\r');
    expect(panel.cleared).toBe(1);
  });

  it('空白內容不送出也不清空', async () => {
    const panel = new FakeInputPanel();
    panel.text = '   ';
    await new SendInputCommand(state, api, panel).execute();
    expect(api.write).not.toHaveBeenCalled();
    expect(panel.cleared).toBe(0);
  });
});
