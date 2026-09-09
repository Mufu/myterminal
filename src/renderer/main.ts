import '@xterm/xterm/css/xterm.css';
import './styles.css';

import { AppState } from './app-state';
import { TerminalView } from './terminal-view';
import { SessionListView } from './session-list-view';
import { ProfileListView } from './profile-list-view';
import { NewConnectionDialog } from './new-connection-dialog';
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
} from './commands';
import { ThemeStore } from './theme';
import type { ClipboardPort, ConfirmPort } from './ports';
import type { ConnectionProfile, SavedProfile } from '../shared/profile';

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

const activeTerminal = (): TerminalView | null =>
  state.activeSessionId ? (terminals.get(state.activeSessionId) ?? null) : null;

const clipboard: ClipboardPort = {
  readText: () => navigator.clipboard.readText(),
  writeText: (text) => navigator.clipboard.writeText(text),
};

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
    syncTerminals();
  } catch (error) {
    view.dispose();
    syncTerminals();
    alert(`建立工作階段失敗：${String(error)}`);
  }
}

/** 讓畫面上顯示的終端機與 AppState 一致，並清掉已關閉工作階段的檢視。*/
function syncTerminals(): void {
  const alive = new Set(state.sessions.map((s) => s.id));
  for (const [id, view] of terminals) {
    if (!alive.has(id)) {
      view.dispose();
      terminals.delete(id);
      continue;
    }
    if (id === state.activeSessionId) view.show();
    else view.hide();
  }
  emptyHint.hidden = state.sessions.length > 0;
}

const confirmRemove: ConfirmPort = (message) => window.confirm(message);

const dialog = new NewConnectionDialog((profile, save) => {
  // 勾了儲存時 validateProfile 已經確保名稱不是空的，所以這裡的轉型是安全的。
  if (save) void api.saveProfile(profile as SavedProfile);
  void createSession(profile);
});

const inputPanel = new InputPanel(
  $<HTMLElement>('input-panel'),
  $<HTMLTextAreaElement>('input-text'),
  $<HTMLElement>('input-target-name'),
  $<HTMLElement>('input-target-dot'),
  state,
  () => activeTerminal()?.resize(),
);

const themeSelect = $<HTMLSelectElement>('theme-select');
themeSelect.value = themeStore.get();

new Toolbar(state, {
  newConnection: new NewConnectionCommand(dialog),
  toggleInput: new ToggleInputPanelCommand(state),
  copy: new CopySelectionCommand(activeTerminal, clipboard),
  paste: new PasteCommand(state, api, clipboard),
  toggleLog: new ToggleLogCommand(state, api),
  clear: new ClearScreenCommand(activeTerminal),
  send: new SendInputCommand(state, api, inputPanel),
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

state.subscribe(syncTerminals);
api.onSessionsChanged((sessions) => state.setSessions(sessions));
api.onProfilesChanged((profiles) => state.setProfiles(profiles));
api.onData(({ id, data }) => {
  const view = terminals.get(id);
  if (view) view.write(data);
  else pendingData.set(id, (pendingData.get(id) ?? '') + data);
});
api.onExit(({ id }) => terminals.get(id)?.write('\r\n\x1b[33m[工作階段已結束]\x1b[0m\r\n'));

window.addEventListener('resize', () => activeTerminal()?.resize());

void api.list().then((sessions) => state.setSessions(sessions));
void api.listProfiles().then((profiles) => state.setProfiles(profiles));
