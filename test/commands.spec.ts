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
  OpenNodeShellCommand,
  OpenNodeCliCommand,
  CopyNodePromptCommand,
  resumeCommand,
  cliStartupCommand,
  StartWorkflowCommand,
  ResumeWorkflowCommand,
  CancelWorkflowCommand,
  SelectSessionCommand,
  OpenEditorCommand,
  CloseEditorCommand,
  SaveWorkflowCommand,
  DeleteWorkflowCommand,
  SaveAndRunWorkflowCommand,
  OpenCliSettingsCommand,
  SaveCliSettingCommand,
  ClearCliKeyCommand,
  LoginCliCommand,
  RefreshCliAuthCommand,
  RescanRolesCommand,
  SetRolesDirCommand,
  errorText,
} from '../src/renderer/commands';
import { WorkflowEditorModel } from '../src/renderer/workflow-editor-model';
import { ThemeStore } from '../src/renderer/theme';
import type { TerminalPort, ClipboardPort, InputPanelPort, DialogPort } from '../src/renderer/ports';
import type { MyTerminalApi } from '../src/shared/api';
import type { SessionInfo } from '../src/shared/session';
import type { ConnectionProfile, SavedProfile } from '../src/shared/profile';
import type { CliAuthStatus } from '../src/shared/cli-auth';
import type { RolesResult } from '../src/shared/ipc';
import type { RoleInfo } from '../src/shared/roles';
import { ROLES } from '../src/shared/roles';

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
  readonly pasted: string[] = [];
  getSelection(): string {
    return this.selection;
  }
  clear(): void {
    this.cleared += 1;
  }
  focus(): void {
    this.focused += 1;
  }
  paste(text: string): void {
    this.pasted.push(text);
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
  sends = 0;
  getText(): string {
    return this.text;
  }
  setText(text: string): void {
    this.text = text;
  }
  sent(): void {
    this.sends += 1;
  }
}

const fakeApi = () =>
  ({
    write: vi.fn().mockResolvedValue(undefined),
    startLog: vi.fn().mockResolvedValue('D:/logs/a.log'),
    stopLog: vi.fn().mockResolvedValue(undefined),
    removeProfile: vi.fn().mockResolvedValue(undefined),
    startWorkflow: vi.fn().mockResolvedValue('run-1'),
    resumeWorkflow: vi.fn().mockResolvedValue(undefined),
    cancelWorkflow: vi.fn().mockResolvedValue(undefined),
    saveWorkflow: vi.fn().mockResolvedValue(undefined),
    deleteWorkflow: vi.fn().mockResolvedValue(undefined),
  }) as unknown as MyTerminalApi & {
    write: ReturnType<typeof vi.fn>;
    startLog: ReturnType<typeof vi.fn>;
    stopLog: ReturnType<typeof vi.fn>;
    removeProfile: ReturnType<typeof vi.fn>;
    startWorkflow: ReturnType<typeof vi.fn>;
    resumeWorkflow: ReturnType<typeof vi.fn>;
    cancelWorkflow: ReturnType<typeof vi.fn>;
    saveWorkflow: ReturnType<typeof vi.fn>;
    deleteWorkflow: ReturnType<typeof vi.fn>;
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
  /** 走 xterm 的貼上路徑：換行歸一化與 bracketed paste 都是它的事。*/
  it('把剪貼簿內容交給終端機貼上，不自己寫進 pty', async () => {
    clipboard.text = 'npm test';
    await new PasteCommand(activeTerminal, clipboard).execute();
    expect(terminal.pasted).toEqual(['npm test']);
    expect(api.write).not.toHaveBeenCalled();
  });

  it('多行的剪貼簿內容也是一整段貼上', async () => {
    clipboard.text = 'echo A\necho B\n';
    await new PasteCommand(activeTerminal, clipboard).execute();
    expect(terminal.pasted).toEqual(['echo A\necho B\n']);
  });

  it('剪貼簿是空的就不貼', async () => {
    clipboard.text = '';
    await new PasteCommand(activeTerminal, clipboard).execute();
    expect(terminal.pasted).toEqual([]);
  });

  it('沒有作用中的終端機就不貼', async () => {
    clipboard.text = 'x';
    await new PasteCommand(() => null, clipboard).execute();
    expect(terminal.pasted).toEqual([]);
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

  /** 已經結束的工作階段不會再有輸出，開下去只會留下一個 0 byte 的檔。*/
  it('已結束的工作階段不開紀錄', async () => {
    state.setSessions([session('s1', { state: 'exited' })]);
    await new ToggleLogCommand(state, api).execute();
    expect(api.startLog).not.toHaveBeenCalled();
  });

  it('已結束但還在紀錄的，停得下來', async () => {
    state.setSessions([session('s1', { state: 'exited', logging: true })]);
    await new ToggleLogCommand(state, api).execute();
    expect(api.stopLog).toHaveBeenCalledWith('s1');
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
  it('整段文字走貼上路徑，再補一個 CR 送出，然後通知面板送出完成', async () => {
    const panel = new FakeInputPanel();
    panel.text = '請幫我重構這段程式';
    await new SendInputCommand(state, api, panel, activeTerminal).execute();
    expect(terminal.pasted).toEqual(['請幫我重構這段程式']);
    expect(api.write).toHaveBeenCalledWith('s1', '\r');
    expect(panel.sends).toBe(1);
  });

  /** 多行不拆開：shell 收到的是一段多行緩衝區，最後那個 CR 才一次執行。*/
  it('多行內容原封不動交給貼上，只送一個 CR', async () => {
    const panel = new FakeInputPanel();
    panel.text = 'echo LINE_ONE\necho LINE_TWO';
    await new SendInputCommand(state, api, panel, activeTerminal).execute();
    expect(terminal.pasted).toEqual(['echo LINE_ONE\necho LINE_TWO']);
    expect(api.write).toHaveBeenCalledTimes(1);
    expect(api.write).toHaveBeenCalledWith('s1', '\r');
  });

  it('空白內容不送出，也不通知面板', async () => {
    const panel = new FakeInputPanel();
    panel.text = '   ';
    await new SendInputCommand(state, api, panel, activeTerminal).execute();
    expect(terminal.pasted).toEqual([]);
    expect(api.write).not.toHaveBeenCalled();
    expect(panel.sends).toBe(0);
  });

  it('沒有作用中的終端機就什麼都不做', async () => {
    const panel = new FakeInputPanel();
    panel.text = 'x';
    await new SendInputCommand(state, api, panel, () => null).execute();
    expect(api.write).not.toHaveBeenCalled();
    expect(panel.sends).toBe(0);
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

  /** 完全放行跑出來的任務，接手之後也要跑得動指令。*/
  it('四支 CLI 完全放行時啟動指令帶著跳過權限的旗標', () => {
    const startup = (over: Partial<SessionInfo>): unknown => {
      const connect = vi.fn();
      new TakeOverCommand(connect, finished(over)).execute();
      return (connect.mock.calls[0][0] as ConnectionProfile & { startupCommand?: string })
        .startupCommand;
    };

    expect(startup({ agentKind: 'claude', agentSessionId: 'x', permission: 'full' })).toBe(
      'claude --resume x --dangerously-skip-permissions',
    );
    expect(startup({ agentKind: 'codex', agentSessionId: 'x', permission: 'full' })).toBe(
      'codex resume x --sandbox danger-full-access',
    );
    expect(startup({ agentKind: 'muse', agentSessionId: 'x', permission: 'full' })).toBe(
      'muse resume x --approval-mode never',
    );
    expect(startup({ agentKind: 'opencode', agentSessionId: 'x', permission: 'full' })).toBe(
      'opencode --session x --auto',
    );
  });

  it('不是完全放行 (含沒記到權限的舊工作階段) 就只有接續那一條', () => {
    const startup = (over: Partial<SessionInfo>): unknown => {
      const connect = vi.fn();
      new TakeOverCommand(connect, finished(over)).execute();
      return (connect.mock.calls[0][0] as ConnectionProfile & { startupCommand?: string })
        .startupCommand;
    };

    for (const kind of ['claude', 'codex', 'muse', 'opencode'] as const) {
      const base = resumeCommand(kind, 'x');
      expect(startup({ agentKind: kind, agentSessionId: 'x', permission: 'readonly' })).toBe(base);
      expect(startup({ agentKind: kind, agentSessionId: 'x', permission: 'edit' })).toBe(base);
      expect(startup({ agentKind: kind, agentSessionId: 'x', permission: undefined })).toBe(base);
    }
  });

  it('resumeCommand 四支 CLI 的形式', () => {
    expect(resumeCommand('claude', 'x')).toBe('claude --resume x');
    expect(resumeCommand('codex', 'x')).toBe('codex resume x');
    expect(resumeCommand('muse', 'x')).toBe('muse resume x');
    // opencode 沒有 resume 子命令，TUI 是用 --session 開回同一段對話。
    expect(resumeCommand('opencode', 'x')).toBe('opencode --session x');
  });
});

describe('畫布上的手動操作', () => {
  const spec = { name: '我的流程 · 實作 shell', shell: 'powershell' as const, cwd: 'D:/work' };

  it('OpenNodeShellCommand 在節點的工作目錄開一個互動式終端機', () => {
    const connect = vi.fn();
    new OpenNodeShellCommand(connect, spec).execute();

    expect(connect).toHaveBeenCalledWith({
      type: 'powershell',
      name: '我的流程 · 實作 shell',
      cwd: 'D:/work',
    });
  });

  it('OpenNodeShellCommand 選了 WSL 就開 WSL', () => {
    const connect = vi.fn();
    new OpenNodeShellCommand(connect, { ...spec, shell: 'wsl' }).execute();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ type: 'wsl' }));
  });

  it('OpenNodeCliCommand 開 CLI 工作階段，並把提示填進輸入面板 (不送出)', () => {
    const connect = vi.fn();
    const panel = new FakeInputPanel();
    new OpenNodeCliCommand(connect, state, panel, {
      ...spec,
      name: '我的流程 · 實作 Claude',
      kind: 'claude',
      permission: 'edit',
      prompt: '請做這件事',
    }).execute();

    expect(connect).toHaveBeenCalledWith({
      type: 'claude',
      name: '我的流程 · 實作 Claude',
      cwd: 'D:/work',
      baseShell: 'powershell',
      // 沒有要接續就不指定，讓「CLI 設定」算出來的那一條生效。
      startupCommand: undefined,
    });
    expect(panel.text).toBe('請做這件事');
    expect(state.inputPanelVisible).toBe(true);
  });

  it('OpenNodeCliCommand 有上一次的對話時用接手那一條指令', () => {
    const connect = vi.fn();
    new OpenNodeCliCommand(connect, state, new FakeInputPanel(), {
      ...spec,
      name: '我的流程 · 實作 Codex',
      kind: 'codex',
      permission: 'edit',
      prompt: 'x',
      resumeId: 'thread-9',
    }).execute();

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex', startupCommand: 'codex resume thread-9' }),
    );
  });

  it('OpenNodeCliCommand 完全放行時啟動指令帶著跳過權限的旗標', () => {
    const connect = vi.fn();
    new OpenNodeCliCommand(connect, state, new FakeInputPanel(), {
      ...spec,
      name: '我的流程 · 實作 Claude',
      kind: 'claude',
      permission: 'full',
      prompt: 'x',
    }).execute();

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ startupCommand: 'claude --dangerously-skip-permissions' }),
    );
  });

  it('cliStartupCommand 四支 CLI 的完全放行旗標，接續時接在後面', () => {
    // 唯讀 / 可修改檔案不指定，讓「CLI 設定」算出來的那一條生效。
    expect(cliStartupCommand('claude', 'readonly')).toBeUndefined();
    expect(cliStartupCommand('claude', 'edit', 'x')).toBe('claude --resume x');

    expect(cliStartupCommand('claude', 'full')).toBe('claude --dangerously-skip-permissions');
    expect(cliStartupCommand('codex', 'full')).toBe('codex --sandbox danger-full-access');
    expect(cliStartupCommand('muse', 'full')).toBe('muse --approval-mode never');
    expect(cliStartupCommand('opencode', 'full')).toBe('opencode --auto');

    expect(cliStartupCommand('claude', 'full', 'x')).toBe(
      'claude --resume x --dangerously-skip-permissions',
    );
  });

  it('CopyNodePromptCommand 把代好的提示放進剪貼簿；空的就不動它', async () => {
    await new CopyNodePromptCommand(clipboard, '請做這件事').execute();
    expect(clipboard.written).toEqual(['請做這件事']);

    await new CopyNodePromptCommand(clipboard, '').execute();
    expect(clipboard.written).toEqual(['請做這件事']);
  });
});

describe('工作流的三個 Command', () => {
  let api: ReturnType<typeof fakeApi>;

  beforeEach(() => {
    api = fakeApi();
  });

  it('StartWorkflowCommand 把範本與參數交給 main，沒填上限就是不限制', async () => {
    await new StartWorkflowCommand(api, 'implement-review-approve', {
      task: '建立 hello.txt',
      cwd: 'D:/tmp',
    }).execute();

    expect(api.startWorkflow).toHaveBeenCalledWith(
      'implement-review-approve',
      { task: '建立 hello.txt', cwd: 'D:/tmp' },
      undefined,
    );
  });

  it('StartWorkflowCommand 把用量上限一起送出去', async () => {
    await new StartWorkflowCommand(api, 'implement-review-approve', {}, 2).execute();
    expect(api.startWorkflow).toHaveBeenCalledWith('implement-review-approve', {}, 2);
  });

  /** main 拒絕 (例如工作目錄不存在) 時對話框要留著顯示原因，所以不能吞掉。*/
  it('StartWorkflowCommand 把 main 的拒絕往外丟', async () => {
    api.startWorkflow.mockRejectedValueOnce(new Error('工作目錄不存在：D:/nope'));
    await expect(
      new StartWorkflowCommand(api, 'implement-review-approve', { cwd: 'D:/nope' }).execute(),
    ).rejects.toThrow('工作目錄不存在：D:/nope');
  });

  it('ResumeWorkflowCommand 分別送出批准與退回', async () => {
    await new ResumeWorkflowCommand(api, 'run-1', true).execute();
    await new ResumeWorkflowCommand(api, 'run-1', false).execute();

    expect(api.resumeWorkflow).toHaveBeenNthCalledWith(1, 'run-1', true);
    expect(api.resumeWorkflow).toHaveBeenNthCalledWith(2, 'run-1', false);
  });

  it('CancelWorkflowCommand 先問過才取消', async () => {
    const asked: string[] = [];
    await new CancelWorkflowCommand(
      api,
      (message) => {
        asked.push(message);
        return true;
      },
      { runId: 'run-1', name: '實作 → 審查 → 批准' },
    ).execute();

    expect(asked).toEqual(['取消工作流「實作 → 審查 → 批准」？']);
    expect(api.cancelWorkflow).toHaveBeenCalledWith('run-1');
  });

  it('不確認就不取消', async () => {
    await new CancelWorkflowCommand(api, () => false, {
      runId: 'run-1',
      name: 'x',
    }).execute();
    expect(api.cancelWorkflow).not.toHaveBeenCalled();
  });
});

describe('畫布編輯器的 Command', () => {
  let api: ReturnType<typeof fakeApi>;
  let model: WorkflowEditorModel;
  let errors: string[][];
  let refreshed: number;

  /** 一份接得起來的最小工作流，存下去才不會被驗證擋掉。*/
  const wired = (): WorkflowEditorModel => {
    const m = new WorkflowEditorModel();
    m.newWorkflow();
    m.connect('start', undefined, 'end');
    return m;
  };

  const save = (): SaveWorkflowCommand =>
    new SaveWorkflowCommand(
      api,
      model,
      (messages) => errors.push(messages),
      () => void (refreshed += 1),
    );

  beforeEach(() => {
    api = fakeApi();
    model = wired();
    errors = [];
    refreshed = 0;
  });

  it('OpenEditorCommand 沒有未存的東西時開一張新的', () => {
    model.setName('改到一半');
    new OpenEditorCommand(state, model).execute();
    expect(state.view).toBe('editor');
    expect(model.definition.name).toBe('改到一半');

    model.markSaved();
    new OpenEditorCommand(state, model).execute();
    expect(model.definition.name).toBe('新工作流');
  });

  /** 去看某個節點的終端機再回來，卡片上的執行檢視要還在。*/
  it('OpenEditorCommand 在畫布那份工作流有執行時留著它', () => {
    model.setName('跑起來了');
    model.markSaved();
    state.setRuns([
      {
        runId: 'run-1',
        workflowId: model.definition.id,
        name: '跑起來了',
        status: 'running',
        params: {},
        nodes: {},
        totalCostUsd: 0,
        startedAt: 1,
      },
    ]);

    new OpenEditorCommand(state, model).execute();
    expect(model.definition.name).toBe('跑起來了');
  });

  it('CloseEditorCommand 切回終端機', () => {
    state.showEditor();
    new CloseEditorCommand(state).execute();
    expect(state.view).toBe('terminal');
  });

  /** 畫布上按節點卡片的「輸出」：要看得到那個終端機，所以畫面也要切回去。*/
  it('SelectSessionCommand 切回終端機並選起那個工作階段', () => {
    state.setSessions([session('s1'), session('s2')]);
    state.showEditor();
    new SelectSessionCommand(state, 's1').execute();
    expect(state.view).toBe('terminal');
    expect(state.activeSessionId).toBe('s1');
  });

  it('SaveWorkflowCommand 存進去之後變乾淨，並重新取一次清單', async () => {
    expect(await save().run()).toBe(true);
    expect(api.saveWorkflow).toHaveBeenCalledWith(model.definition);
    expect(model.dirty).toBe(false);
    expect(model.source).toBe('custom');
    expect(errors).toEqual([[]]);
    expect(refreshed).toBe(1);
  });

  it('不合法就顯示錯誤，不送出去', async () => {
    model.newWorkflow(); // 結束節點還沒接上
    expect(await save().run()).toBe(false);
    expect(api.saveWorkflow).not.toHaveBeenCalled();
    expect(errors).toEqual([['節點 end 從開始節點走不到']]);
  });

  it('內建範本存成副本，不會蓋掉範本', async () => {
    const template = { ...model.definition, id: 'implement-review-approve', name: '範本' };
    model.load(template, 'builtin');

    expect(await save().run()).toBe(true);
    const saved = api.saveWorkflow.mock.calls[0][0];
    expect(saved.id).not.toBe('implement-review-approve');
    expect(saved.id).toMatch(/^wf-/);
    expect(saved.name).toBe('範本 (副本)');
    // 畫布接著編輯的就是那份副本
    expect(model.definition.id).toBe(saved.id);
    expect(model.source).toBe('custom');
  });

  it('main 拒絕時把訊息顯示出來，畫布還是髒的', async () => {
    api.saveWorkflow.mockRejectedValueOnce(new Error('不能覆蓋內建範本'));
    expect(await save().run()).toBe(false);
    expect(errors).toEqual([['不能覆蓋內建範本']]);
    expect(model.dirty).toBe(true);
  });

  it('DeleteWorkflowCommand 確認之後才刪，刪完回到新的畫布', async () => {
    const id = model.definition.id;
    const asked: string[] = [];
    await new DeleteWorkflowCommand(
      api,
      (message) => {
        asked.push(message);
        return true;
      },
      model,
      () => void (refreshed += 1),
    ).execute();

    expect(asked).toEqual(['刪除工作流「新工作流」？']);
    expect(api.deleteWorkflow).toHaveBeenCalledWith(id);
    expect(model.definition.id).not.toBe(id);
    expect(refreshed).toBe(1);
  });

  it('不確認就不刪', async () => {
    await new DeleteWorkflowCommand(api, () => false, model, () => {}).execute();
    expect(api.deleteWorkflow).not.toHaveBeenCalled();
  });

  it('SaveAndRunWorkflowCommand 存好才開執行對話框', async () => {
    const opened: string[] = [];
    await new SaveAndRunWorkflowCommand(save(), model, (id) => opened.push(id)).execute();
    expect(opened).toEqual([model.definition.id]);
  });

  it('存不起來就不開執行對話框', async () => {
    model.newWorkflow();
    const opened: string[] = [];
    await new SaveAndRunWorkflowCommand(save(), model, (id) => opened.push(id)).execute();
    expect(opened).toEqual([]);
  });
});

describe('errorText', () => {
  it('把 Electron 包在外面的 IPC 外殼剥掉', () => {
    const raw = new Error(
      "Error invoking remote method 'session:create': Error: 工作目錄不存在：D:/nope",
    );
    expect(errorText(raw)).toBe('工作目錄不存在：D:/nope');
  });

  it('一般的 Error 就是它的訊息', () => {
    expect(errorText(new Error('不能覆蓋內建範本'))).toBe('不能覆蓋內建範本');
  });

  it('不是 Error 的東西也變成字串', () => {
    expect(errorText('壞掉了')).toBe('壞掉了');
    expect(errorText(undefined)).toBe('undefined');
  });
});

describe('CLI 設定', () => {
  /** 重新偵測回來的那一份；內容不重要，能認出是同一份就好。*/
  const CLI_STATUS: CliAuthStatus = {
    claude: { loggedIn: true, mode: 'subscription', plan: 'max', label: 'Max 訂閱' },
    codex: { loggedIn: false, mode: 'unknown', label: '未登入' },
    muse: { loggedIn: false, mode: 'unknown', label: '找不到指令' },
    opencode: { loggedIn: false, mode: 'unknown', label: '未登入' },
  };

  /** 這一組 Command 只用到這幾個方法，就不拉進上面那份 fakeApi。*/
  const cliApi = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      saveCliSetting: vi.fn().mockResolvedValue({ claude: { mode: 'apiKey', hasKey: true } }),
      clearCliKey: vi.fn().mockResolvedValue({ claude: { mode: 'apiKey', hasKey: false } }),
      cliLogin: vi.fn().mockResolvedValue('s9'),
      cliRefresh: vi.fn().mockResolvedValue(CLI_STATUS),
      ...over,
    }) as unknown as MyTerminalApi & {
      saveCliSetting: ReturnType<typeof vi.fn>;
      clearCliKey: ReturnType<typeof vi.fn>;
      cliLogin: ReturnType<typeof vi.fn>;
      cliRefresh: ReturnType<typeof vi.fn>;
    };

  it('⚙ 打開對話框', () => {
    let opened = 0;
    const dialog: DialogPort = { open: () => (opened += 1) };
    new OpenCliSettingsCommand(dialog).execute();
    expect(opened).toBe(1);
  });

  it('存設定：送出去並把新的設定交給呼叫端', async () => {
    const cli = cliApi();
    const saved: unknown[] = [];
    const errors: string[][] = [];
    await new SaveCliSettingCommand(
      cli,
      { id: 'claude', mode: 'apiKey', apiKey: 'sk-1' },
      false,
      (settings) => saved.push(settings),
      (messages) => errors.push(messages),
    ).execute();

    expect(cli.saveCliSetting).toHaveBeenCalledWith({
      id: 'claude',
      mode: 'apiKey',
      apiKey: 'sk-1',
    });
    expect(saved).toHaveLength(1);
    expect(errors).toEqual([[]]);
  });

  it('驗證沒過就不碰 main', async () => {
    const cli = cliApi();
    const errors: string[][] = [];
    await new SaveCliSettingCommand(
      cli,
      { id: 'claude', mode: 'apiKey' },
      false,
      () => {},
      (messages) => errors.push(messages),
    ).execute();

    expect(cli.saveCliSetting).not.toHaveBeenCalled();
    expect(errors).toEqual([['請輸入 API 金鑰']]);
  });

  it('main 拒絕時把原因顯示出來', async () => {
    const cli = cliApi({ saveCliSetting: vi.fn().mockRejectedValue(new Error('存不進去')) });
    const errors: string[][] = [];
    await new SaveCliSettingCommand(
      cli,
      { id: 'claude', mode: 'login' },
      false,
      () => {},
      (messages) => errors.push(messages),
    ).execute();

    expect(errors).toEqual([['存不進去']]);
  });

  it('清除金鑰也回傳新的設定', async () => {
    const cli = cliApi();
    const cleared: unknown[] = [];
    await new ClearCliKeyCommand(cli, 'claude', (s) => cleared.push(s), () => {}).execute();
    expect(cli.clearCliKey).toHaveBeenCalledWith('claude');
    expect(cleared).toHaveLength(1);
  });

  it('登入：開一個工作階段並把 id 交出去', async () => {
    const cli = cliApi();
    const started: string[] = [];
    await new LoginCliCommand(cli, 'codex', (id) => void started.push(id), () => {}).execute();
    expect(cli.cliLogin).toHaveBeenCalledWith('codex');
    expect(started).toEqual(['s9']);
  });

  it('OpenCode 沒有登入流程，main 拒絕時顯示原因', async () => {
    const cli = cliApi({
      cliLogin: vi.fn().mockRejectedValue(new Error('OpenCode 只能使用 API 金鑰')),
    });
    const errors: string[][] = [];
    await new LoginCliCommand(cli, 'opencode', () => {}, (m) => errors.push(m)).execute();
    expect(errors).toEqual([['OpenCode 只能使用 API 金鑰']]);
  });

  it('重新偵測：探測中先標成偵測中，結果回來才換上去', async () => {
    let finish!: (status: CliAuthStatus) => void;
    const cli = cliApi({
      cliRefresh: vi.fn(() => new Promise<CliAuthStatus>((resolve) => (finish = resolve))),
    });
    const state = new AppState();

    const done = new RefreshCliAuthCommand(cli, state).execute();
    expect(state.cliProbing).toBe(true);
    expect(state.cliAuth).toBeNull();

    finish(CLI_STATUS);
    await done;

    expect(state.cliProbing).toBe(false);
    expect(state.cliAuth).toEqual(CLI_STATUS);
  });

  it('重新偵測失敗也要把「偵測中」收回來，按鈕才不會一直停用', async () => {
    const cli = cliApi({ cliRefresh: vi.fn().mockRejectedValue(new Error('探不到')) });
    const state = new AppState();

    await expect(new RefreshCliAuthCommand(cli, state).execute()).rejects.toThrow('探不到');
    expect(state.cliProbing).toBe(false);
  });
});

describe('角色庫', () => {
  const libRole: RoleInfo = {
    id: 'lib:engineering/code-reviewer',
    label: 'Code Reviewer',
    systemPrompt: 'You are Code Reviewer.',
    defaultPermission: 'readonly',
    source: 'library',
    division: 'Engineering',
  };

  const scan = (over: Partial<RolesResult> = {}): RolesResult => ({
    roles: [...ROLES, libRole],
    dir: 'D:\\roles',
    skipped: [{ relPath: 'README.md', reason: '沒有 frontmatter 的 name' }],
    scannedAt: 1,
    ...over,
  });

  /** 這一組 Command 只用到這兩個方法。*/
  const rolesApi = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      rescanRoles: vi.fn().mockResolvedValue(scan()),
      setRolesDir: vi.fn().mockResolvedValue(scan({ dir: 'D:\\新的' })),
      ...over,
    }) as unknown as MyTerminalApi & {
      rescanRoles: ReturnType<typeof vi.fn>;
      setRolesDir: ReturnType<typeof vi.fn>;
    };

  it('重新掃描：AppState 換上新清單，整份結果交給對話框', async () => {
    const api = rolesApi();
    const state = new AppState();
    const results: RolesResult[] = [];

    await new RescanRolesCommand(api, state, (result) => results.push(result)).execute();

    expect(api.rescanRoles).toHaveBeenCalled();
    expect(state.roles.at(-1)).toEqual(libRole);
    expect(results[0].skipped).toHaveLength(1);
  });

  it('換資料夾：把路徑交給 main，回來的結果同樣進 AppState', async () => {
    const api = rolesApi();
    const state = new AppState();
    const results: RolesResult[] = [];

    await new SetRolesDirCommand(api, state, 'D:\\新的', (r) => results.push(r)).execute();

    expect(api.setRolesDir).toHaveBeenCalledWith('D:\\新的');
    expect(results[0].dir).toBe('D:\\新的');
    expect(state.roles).toHaveLength(ROLES.length + 1);
  });

  it('main 拒絕時只顯示原因，清單留著原來那一份', async () => {
    const api = rolesApi({
      setRolesDir: vi.fn().mockRejectedValue(new Error('角色資料夾不存在：D:\\沒有')),
    });
    const state = new AppState();
    const errors: string[] = [];

    await new SetRolesDirCommand(api, state, 'D:\\沒有', () => {}, (m) => errors.push(m)).execute();

    expect(errors).toEqual(['角色資料夾不存在：D:\\沒有']);
    expect(state.roles).toEqual([...ROLES]);
  });
});
