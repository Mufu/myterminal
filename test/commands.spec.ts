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
  SwitchThemeCommand,
  ConnectFromProfileCommand,
  RemoveProfileCommand,
  TakeOverCommand,
  resumeCommand,
} from '../src/renderer/commands';
import { ThemeStore } from '../src/renderer/theme';
import type { TerminalPort, ClipboardPort, InputPanelPort, DialogPort } from '../src/renderer/ports';
import type { MyTerminalApi } from '../src/shared/api';
import type { SessionInfo } from '../src/shared/session';
import type { ConnectionProfile, SavedProfile } from '../src/shared/profile';

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
    removeProfile: vi.fn().mockResolvedValue(undefined),
  }) as unknown as MyTerminalApi & {
    write: ReturnType<typeof vi.fn>;
    startLog: ReturnType<typeof vi.fn>;
    stopLog: ReturnType<typeof vi.fn>;
    removeProfile: ReturnType<typeof vi.fn>;
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

describe('切換主題', () => {
  const store = () => new ThemeStore({ getItem: () => null, setItem: () => {} }, () => {});

  it('把下拉選單選到的主題交給 ThemeStore', () => {
    const theme = store();
    new SwitchThemeCommand(theme, () => 'warm').execute();
    expect(theme.get()).toBe('warm');
  });

  it('選到不認得的值時退回深色', () => {
    const theme = store();
    theme.set('light');
    new SwitchThemeCommand(theme, () => '???').execute();
    expect(theme.get()).toBe('dark');
  });
});

describe('從已儲存連線建立工作階段', () => {
  const profile: SavedProfile = { type: 'ssh', name: '部署機', host: 'build-server', user: 'deploy' };

  it('把整個設定檔交給建立工作階段的流程', () => {
    const connected: ConnectionProfile[] = [];
    new ConnectFromProfileCommand((p) => connected.push(p), profile).execute();
    expect(connected).toEqual([profile]);
  });
});

describe('刪除已儲存連線', () => {
  it('確認之後才刪除', async () => {
    const asked: string[] = [];
    await new RemoveProfileCommand(
      api,
      (message) => {
        asked.push(message);
        return true;
      },
      '我的 PS',
    ).execute();
    expect(asked).toEqual(['刪除連線設定「我的 PS」？']);
    expect(api.removeProfile).toHaveBeenCalledWith('我的 PS');
  });

  it('取消時不刪除', async () => {
    await new RemoveProfileCommand(api, () => false, '我的 PS').execute();
    expect(api.removeProfile).not.toHaveBeenCalled();
  });
});

describe('TakeOverCommand', () => {
  const finished = (over: Partial<SessionInfo> = {}): SessionInfo =>
    session('s1', {
      name: 'Agent 1',
      type: 'agent',
      state: 'exited',
      cwd: 'C:/work',
      agentKind: 'claude',
      agentSessionId: 'a7c9c5c6-ae75-4090-9d47-13fc2c0f23b7',
      ...over,
    });

  it('用既有的 Claude 型別開一個互動式工作階段，啟動指令是 --resume', () => {
    const connect = vi.fn();
    new TakeOverCommand(connect, finished()).execute();

    expect(connect).toHaveBeenCalledWith({
      type: 'claude',
      name: '接手 Agent 1',
      cwd: 'C:/work',
      baseShell: 'powershell',
      startupCommand: 'claude --resume a7c9c5c6-ae75-4090-9d47-13fc2c0f23b7',
    });
  });

  it('Codex 用 codex resume', () => {
    const connect = vi.fn();
    new TakeOverCommand(connect, finished({ agentKind: 'codex', agentSessionId: 't-1' })).execute();

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex', startupCommand: 'codex resume t-1' }),
    );
  });

  it('還沒有 session id 就什麼都不做', () => {
    const connect = vi.fn();
    new TakeOverCommand(connect, finished({ agentSessionId: undefined })).execute();
    expect(connect).not.toHaveBeenCalled();
  });

  it('resumeCommand 兩種 CLI 的形式', () => {
    expect(resumeCommand('claude', 'x')).toBe('claude --resume x');
    expect(resumeCommand('codex', 'x')).toBe('codex resume x');
  });
});
