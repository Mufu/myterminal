import '@xterm/xterm/css/xterm.css';
import './styles.css';

import { AppState } from './app-state';
import { TerminalView } from './terminal-view';
import { SessionListView } from './session-list-view';
import { ProfileListView } from './profile-list-view';
import { WorkflowListView } from './workflow-list-view';
import { CliStatusView } from './cli-status-view';
import { NewConnectionDialog } from './new-connection-dialog';
import { CliSettingsDialog } from './cli-settings-dialog';
import { WorkflowRunDialog } from './workflow-run-dialog';
import { InputPanel } from './input-panel';
import { Toolbar } from './toolbar';
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
  StartWorkflowCommand,
  ResumeWorkflowCommand,
  CancelWorkflowCommand,
  SelectSessionCommand,
  OpenNodeShellCommand,
  OpenNodeCliCommand,
  CopyNodePromptCommand,
  OpenEditorCommand,
  CloseEditorCommand,
  SaveWorkflowCommand,
  DeleteWorkflowCommand,
  SaveAndRunWorkflowCommand,
  OpenCliSettingsCommand,
  errorText,
} from './commands';
import { WorkflowEditorModel } from './workflow-editor-model';
import { WorkflowEditorView } from './workflow-editor-view';
import { CwdPromptDialog } from './cwd-prompt-dialog';
import type { AgentNode } from './node-shell';
import {
  cliSessionName,
  nodeShell,
  renderNodePrompt,
  resolveNodeCwd,
  shellSessionName,
} from './node-shell';
import { latestRunFor } from './workflow-run-view';
import { ThemeStore } from './theme';
import type { ClipboardPort, ConfirmPort } from './ports';
import type { ConnectionProfile, SavedProfile } from '../shared/profile';
import type { RunState, WorkflowInfo } from '../shared/workflow';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`找不到元素 #${id}`);
  return el as T;
};

// 主題要在畫面畫出來之前就套上去，所以是第一件事。
const themeStore = new ThemeStore();

const api = window.myterminal;
const state = new AppState();

/** sessionId -> TerminalView。只有作用中的那個會顯示。*/
const terminals = new Map<string, TerminalView>();
/**
 * 還沒認領的輸出。main 送 session:data 可能比 createSession 的回覆更早到
 * (agent 任務的第一行標題就是同步發出的)，那時還不知道 id 對應哪個 TerminalView。
 */
const pendingData = new Map<string, string>();
const terminalsEl = $<HTMLDivElement>('terminals');
const emptyHint = $<HTMLDivElement>('empty-hint');
const terminalArea = $<HTMLElement>('terminal-area');
const editorEl = $<HTMLElement>('workflow-editor');

const activeTerminal = (): TerminalView | null =>
  state.activeSessionId ? (terminals.get(state.activeSessionId) ?? null) : null;

const clipboard: ClipboardPort = {
  readText: () => navigator.clipboard.readText(),
  writeText: (text) => navigator.clipboard.writeText(text),
};

/**
 * 還沒收到 id 的 createSession 個數。main 自己開的工作階段要補一個終端機檢視
 * (見 adoptTerminal)，但這期間 state 裡可能已經有一個「檢視還沒認領 id」的
 * 工作階段，補下去會變成同一個 id 兩個檢視。
 */
let pendingCreates = 0;

/** 建立工作階段：先開終端機量出 cols/rows，再請 main spawn。*/
async function createSession(profile: ConnectionProfile): Promise<void> {
  let id: string | null = null;
  const view = new TerminalView(
    terminalsEl,
    {
      onInput: (data) => {
        if (id) void api.write(id, data);
      },
      onResize: (cols, rows) => {
        if (id) void api.resize(id, cols, rows);
      },
    },
    themeStore,
  );

  activeTerminal()?.hide();
  view.show();
  pendingCreates += 1;

  try {
    const { cols, rows } = view.dimensions;
    const info = await api.createSession(profile, cols, rows);
    id = info.id;
    terminals.set(info.id, view);
    const buffered = pendingData.get(info.id);
    if (buffered !== undefined) {
      view.write(buffered);
      pendingData.delete(info.id);
    }
    // main 的 created 事件「通常」比 invoke 的回覆更早到，但兩者走不同的 IPC 佇列，
    // 順序沒有保證。反過來的時候 state.sessions 還看不到這個 id，
    // 下面的 syncTerminals() 就會把剛建好的 view 當成殘留的清掉 (畫面一片空白)。
    if (!state.sessions.some((s) => s.id === info.id)) {
      state.setSessions([...state.sessions, info]);
    }
    state.setActive(info.id);
    // 在畫布上開的新連接也要看得到；畫布上沒存的東西留著，只是不顯示。
    state.showTerminal();
    syncTerminals();
  } catch (error) {
    view.dispose();
    alert(`建立工作階段失敗：${errorText(error)}`);
  } finally {
    pendingCreates -= 1;
    syncTerminals();
  }
}

/**
 * main 自己開的工作階段 (工作流的節點) 沒有經過 createSession，
 * 所以第一次在清單裡看到它的時候要補一個終端機檢視，
 * 點節點那一列才有東西可以看。
 */
function adoptTerminal(id: string): void {
  const view = new TerminalView(
    terminalsEl,
    {
      onInput: (data) => void api.write(id, data),
      onResize: (cols, rows) => void api.resize(id, cols, rows),
    },
    themeStore,
  );
  view.hide();
  terminals.set(id, view);

  const buffered = pendingData.get(id);
  if (buffered !== undefined) {
    view.write(buffered);
    pendingData.delete(id);
  }
}

/**
 * 上一次把焦點交出去的工作階段。syncTerminals() 每次狀態變動都會跑，
 * 每次都 focus() 會把使用者正在輸入字面板裡打的字 (含 IME 正在組的字) 搶走，
 * 所以只有真的換了工作階段才搶。
 */
let focusedSessionId: string | null = null;

/** 讓畫面上顯示的終端機與 AppState 一致，並清掉已關閉工作階段的檢視。*/
function syncTerminals(): void {
  const alive = new Set(state.sessions.map((s) => s.id));
  if (pendingCreates === 0) {
    for (const id of alive) if (!terminals.has(id)) adoptTerminal(id);
  }
  for (const [id, view] of terminals) {
    if (!alive.has(id)) {
      view.dispose();
      terminals.delete(id);
      continue;
    }
    if (id === state.activeSessionId) {
      view.show();
      if (focusedSessionId !== id) {
        focusedSessionId = id;
        view.focus();
      }
    } else view.hide();
  }
  if (state.activeSessionId === null) focusedSessionId = null;
  emptyHint.hidden = state.sessions.length > 0;
}

const confirmRemove: ConfirmPort = (message) => window.confirm(message);

const dialog = new NewConnectionDialog((profile, save) => {
  // 勾了儲存時 validateProfile 已經確保名稱不是空的，所以這裡的轉型是安全的。
  // 存不進去 (例如目錄唯讀) 要讓使用者知道，不能默默失敗。
  if (save) {
    void api
      .saveProfile(profile as SavedProfile)
      .catch((error: unknown) => alert(`儲存連線設定失敗：${errorText(error)}`));
  }
  void createSession(profile);
});

const inputPanel = new InputPanel(
  $<HTMLElement>('input-panel'),
  $<HTMLTextAreaElement>('input-text'),
  $<HTMLElement>('input-target-name'),
  $<HTMLElement>('input-target-dot'),
  state,
  (visible) => {
    const terminal = activeTerminal();
    terminal?.resize();
    // 收起來的時候焦點要還給終端機；打開的時候留在輸入區 (面板自己會 focus)。
    if (!visible) terminal?.focus();
  },
);

const themeSelect = $<HTMLSelectElement>('theme-select');
themeSelect.value = themeStore.get();

new Toolbar(state, {
  newConnection: new NewConnectionCommand(dialog),
  toggleInput: new ToggleInputPanelCommand(state),
  copy: new CopySelectionCommand(activeTerminal, clipboard),
  paste: new PasteCommand(activeTerminal, clipboard),
  toggleLog: new ToggleLogCommand(state, api),
  clear: new ClearScreenCommand(activeTerminal),
  send: new SendInputCommand(state, api, inputPanel, activeTerminal),
  switchTheme: new SwitchThemeCommand(themeStore, () => themeSelect.value),
});

new SessionListView(
  $<HTMLUListElement>('session-list'),
  $<HTMLElement>('session-count'),
  state,
  (id) => void api.close(id),
  (session) => new TakeOverCommand((p) => void createSession(p), session).execute(),
);

new ProfileListView(
  $<HTMLUListElement>('profile-list'),
  $<HTMLElement>('profile-count'),
  state,
  (profile) => new ConnectFromProfileCommand((p) => void createSession(p), profile).execute(),
  (name) => void new RemoveProfileCommand(api, confirmRemove, name).execute(),
);

// 回傳 Promise：main 拒絕 (例如工作目錄不存在) 時對話框要留著顯示原因。
const workflowDialog = new WorkflowRunDialog((workflowId, params, maxTotalCostUsd) =>
  new StartWorkflowCommand(api, workflowId, params, maxTotalCostUsd).execute(),
);
$<HTMLButtonElement>('btn-workflow-run').addEventListener('click', () => workflowDialog.open());

// 畫布編輯器：編輯的就是那份 WorkflowDefinition，存出去之後跟內建範本同一種東西。
const editorModel = new WorkflowEditorModel();
/** 執行對話框與畫布的下拉選單共用這一份清單，存完要重新取一次。*/
let workflowInfos: WorkflowInfo[] = [];

async function refreshWorkflows(): Promise<void> {
  workflowInfos = await api.listWorkflows();
  workflowDialog.setWorkflows(workflowInfos);
  editorView.setWorkflows(workflowInfos);
}

/** 下拉選單換一份定義；手上還有沒存的東西就先問一次。*/
async function pickWorkflow(id: string): Promise<void> {
  if (editorModel.dirty && !confirmRemove('畫布上的變更還沒儲存，要放棄嗎？')) return;
  if (!id) {
    editorModel.newWorkflow();
    return;
  }
  const definition = await api.getWorkflow(id);
  if (!definition) return;
  const builtin = workflowInfos.find((info) => info.id === id)?.builtin ?? false;
  editorModel.load(definition, builtin ? 'builtin' : 'custom');
}

const editorView = new WorkflowEditorView(
  editorModel,
  {
    close: () => new CloseEditorCommand(state).execute(),
    save: () => void saveWorkflow.execute(),
    saveAndRun: () =>
      void new SaveAndRunWorkflowCommand(saveWorkflow, editorModel, (id) =>
        workflowDialog.open(id),
      ).execute(),
    remove: () =>
      void new DeleteWorkflowCommand(api, confirmRemove, editorModel, refreshWorkflows).execute(),
    pick: (id) => void pickWorkflow(id),
    openTerminal: (sessionId) => new SelectSessionCommand(state, sessionId).execute(),
    takeOver: (sessionId) => takeOver(sessionId),
    openShell: (nodeId) => openNodeShell(nodeId),
    openCli: (nodeId) => openNodeCli(nodeId),
    copyPrompt: (nodeId) => copyNodePrompt(nodeId),
    resume: (runId, approved) => void new ResumeWorkflowCommand(api, runId, approved).execute(),
    cancel: (run) => void new CancelWorkflowCommand(api, confirmRemove, run).execute(),
  },
  state,
);

/**
 * 畫布上的「手動操作」：不跑無介面的執行，直接在節點的工作目錄開一個
 * 互動式終端機，prompt 由人自己下。
 */
const cwdPrompt = new CwdPromptDialog();

/** 畫布上那份工作流最近一次執行；{{params.x}} 就是從它代出來的。*/
const editorRun = (): RunState | null => latestRunFor(state.runs, editorModel.definition.id);

function agentNode(nodeId: string): AgentNode | null {
  const node = editorModel.node(nodeId);
  return node?.type === 'agent' ? node : null;
}

/** 工作目錄代不出來 (例如 {{params.cwd}} 但還沒跑過) 就問一次。*/
function withNodeCwd(node: AgentNode, use: (cwd: string) => void): void {
  const cwd = resolveNodeCwd(node, editorRun());
  if (cwd) use(cwd);
  else cwdPrompt.ask(use);
}

function openNodeShell(nodeId: string): void {
  const node = agentNode(nodeId);
  if (!node) return;
  withNodeCwd(node, (cwd) =>
    new OpenNodeShellCommand((profile) => void createSession(profile), {
      name: shellSessionName(editorModel.definition.name, node),
      shell: nodeShell(node),
      cwd,
    }).execute(),
  );
}

function openNodeCli(nodeId: string): void {
  const node = agentNode(nodeId);
  if (!node) return;
  withNodeCwd(node, (cwd) =>
    new OpenNodeCliCommand((profile) => void createSession(profile), state, inputPanel, {
      name: cliSessionName(editorModel.definition.name, node),
      shell: nodeShell(node),
      cwd,
      kind: node.config.kind,
      prompt: renderNodePrompt(node, editorRun()),
      resumeId: nodeResumeId(node),
    }).execute(),
  );
}

/** 這個節點跑過的話就接續它那段對話；換了一支 CLI 就接不上了。*/
function nodeResumeId(node: AgentNode): string | undefined {
  const sessionId = editorRun()?.nodes[node.id]?.sessionId;
  const session = state.sessions.find((s) => s.id === sessionId);
  return session?.agentKind === node.config.kind ? session.agentSessionId : undefined;
}

function copyNodePrompt(nodeId: string): void {
  const node = agentNode(nodeId);
  if (!node) return;
  void new CopyNodePromptCommand(clipboard, renderNodePrompt(node, editorRun())).execute();
}

/** 畫布上的「接手」：節點的工作階段本身知道是哪一支 CLI、哪一段對話。*/
function takeOver(sessionId: string): void {
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  new TakeOverCommand((profile) => void createSession(profile), session).execute();
}

const saveWorkflow = new SaveWorkflowCommand(
  api,
  editorModel,
  (messages) => editorView.showErrors(messages),
  refreshWorkflows,
);

$<HTMLButtonElement>('btn-workflow-edit').addEventListener('click', () =>
  new OpenEditorCommand(state, editorModel).execute(),
);

/** 切畫面：終端機那三塊收起來，畫布顯示出來 (或反過來)。*/
function syncView(): void {
  const editing = state.view === 'editor';
  terminalArea.classList.toggle('editing', editing);
  editorEl.hidden = !editing;
}

new WorkflowListView(
  $<HTMLUListElement>('workflow-list'),
  state,
  (runId, approved) => void new ResumeWorkflowCommand(api, runId, approved).execute(),
  (run) => void new CancelWorkflowCommand(api, confirmRemove, run).execute(),
  // 節點那一列點下去就是切換工作階段，跟點右側清單是同一件事。
  (sessionId) => state.setActive(sessionId),
);

new CliStatusView(
  {
    claude: $<HTMLElement>('cli-claude'),
    codex: $<HTMLElement>('cli-codex'),
    muse: $<HTMLElement>('cli-muse'),
    opencode: $<HTMLElement>('cli-opencode'),
  },
  state,
);

/**
 * 「CLI 設定」。登入開出來的是 main 自己建的工作階段，所以 invoke 回來之後
 * 重新問一次清單再切過去 —— created 事件與這個回覆走不同的 IPC 佇列，
 * 順序沒有保證，直接 setActive 可能切不過去。
 */
const cliSettingsDialog = new CliSettingsDialog(state, api, async (sessionId) => {
  state.setSessions(await api.list());
  state.setActive(sessionId);
});
const openCliSettings = new OpenCliSettingsCommand(cliSettingsDialog);
$<HTMLElement>('cli-status').addEventListener('click', () => openCliSettings.execute());

// 順序有意義：先把畫布收起來，syncTerminals 才量得到終端機的寬度。
state.subscribe(syncView);
state.subscribe(syncTerminals);
api.onSessionsChanged((sessions) => state.setSessions(sessions));
api.onProfilesChanged((profiles) => state.setProfiles(profiles));
api.onWorkflowChanged((runs) => state.setRuns(runs));
// 登入流程跑完之後 main 重探的結果。
api.onCliAuthChanged((auth) => state.setCliAuth(auth));
api.onData(({ id, data }) => {
  const view = terminals.get(id);
  if (view) view.write(data);
  else pendingData.set(id, (pendingData.get(id) ?? '') + data);
});
api.onExit(({ id }) => terminals.get(id)?.write('\r\n\x1b[33m[工作階段已結束]\x1b[0m\r\n'));

window.addEventListener('resize', () => activeTerminal()?.resize());

void api.list().then((sessions) => state.setSessions(sessions));
void api.listProfiles().then((profiles) => state.setProfiles(profiles));
void api.workflowRuns().then((runs) => state.setRuns(runs));
// 登入方式決定金額怎麼寫，以及執行對話框要不要先填一個用量上限。
void api.cliAuth().then((auth) => {
  state.setCliAuth(auth);
  workflowDialog.setBillingMode(auth.claude.mode);
});
// 使用者自己選的登入方式：晶片上的字以它為準 (選了金鑰就是拿金鑰在跑)。
void api.cliSettings().then((settings) => state.setCliSettings(settings));
void refreshWorkflows();
