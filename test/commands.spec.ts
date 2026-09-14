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
  StartWorkflowCommand,
  ResumeWorkflowCommand,
  CancelWorkflowCommand,
  OpenEditorCommand,
  CloseEditorCommand,
  SaveWorkflowCommand,
  DeleteWorkflowCommand,
  SaveAndRunWorkflowCommand,
} from '../src/renderer/commands';
import { WorkflowEditorModel } from '../src/renderer/workflow-editor-model';
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

  /** shell 一行就是一個指令：LF 會被 PSReadLine 當成軟斷行，整段都不會執行。*/
  it.each(['powershell', 'wsl', 'ssh', 'custom'] as const)(
    '%s：多行的每一行都換成 CR，每一行都是 Enter',
    async (type) => {
      state.setSessions([session('s1', { type })]);
      const panel = new FakeInputPanel();
      panel.text = 'echo LINE_ONE\necho LINE_TWO';
      await new SendInputCommand(state, api, panel).execute();
      expect(api.write).toHaveBeenCalledWith('s1', 'echo LINE_ONE\recho LINE_TWO\r');
    },
  );

  it('CRLF 的換行也算一行 (貼進來的文字可能帶 \\r\\n)', async () => {
    state.setSessions([session('s1', { type: 'powershell' })]);
    const panel = new FakeInputPanel();
    panel.text = 'echo A\r\necho B';
    await new SendInputCommand(state, api, panel).execute();
    expect(api.write).toHaveBeenCalledWith('s1', 'echo A\recho B\r');
  });

  /** claude / codex / agent 收的是一段多行提示，裡面的 LF 就是換行 (Ctrl+J)。*/
  it.each(['claude', 'codex', 'agent'] as const)(
    '%s：保留段落裡的換行，最後才送一個 CR',
    async (type) => {
      state.setSessions([session('s1', { type })]);
      const panel = new FakeInputPanel();
      panel.text = '第一行\n第二行';
      await new SendInputCommand(state, api, panel).execute();
      expect(api.write).toHaveBeenCalledWith('s1', '第一行\n第二行\r');
    },
  );
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

  it('CloseEditorCommand 切回終端機', () => {
    state.showEditor();
    new CloseEditorCommand(state).execute();
    expect(state.view).toBe('terminal');
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
