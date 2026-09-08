import '@xterm/xterm/css/xterm.css';
import './styles.css';

import { AppState } from './app-state';
import { TerminalView } from './terminal-view';
import { SessionListView } from './session-list-view';
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
} from './commands';
import type { ClipboardPort } from './ports';
import type { ConnectionProfile } from '../shared/profile';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`找不到元素 #${id}`);
  return el as T;
};

const api = window.myterminal;
const state = new AppState();

/** sessionId -> TerminalView。只有作用中的那個會顯示。*/
const terminals = new Map<string, TerminalView>();
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
  const view = new TerminalView(terminalsEl, {
    onInput: (data) => {
      if (id) void api.write(id, data);
    },
    onResize: (cols, rows) => {
      if (id) void api.resize(id, cols, rows);
    },
  });

  activeTerminal()?.hide();
  view.show();

  try {
    const { cols, rows } = view.dimensions;
    const info = await api.createSession(profile, cols, rows);
    id = info.id;
    terminals.set(info.id, view);
    state.setActive(info.id);
    // main 的 created 事件通常比 invoke 的回覆更早到，那時 terminals 還沒有這個 view，
    // 所以這裡要再同步一次畫面。
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

const dialog = new NewConnectionDialog((profile) => void createSession(profile));

const inputPanel = new InputPanel(
  $<HTMLElement>('input-panel'),
  $<HTMLTextAreaElement>('input-text'),
  $<HTMLElement>('input-target-name'),
  $<HTMLElement>('input-target-dot'),
  state,
  () => activeTerminal()?.resize(),
);

new Toolbar(state, {
  newConnection: new NewConnectionCommand(dialog),
  toggleInput: new ToggleInputPanelCommand(state),
  copy: new CopySelectionCommand(activeTerminal, clipboard),
  paste: new PasteCommand(state, api, clipboard),
  toggleLog: new ToggleLogCommand(state, api),
  clear: new ClearScreenCommand(activeTerminal),
  send: new SendInputCommand(state, api, inputPanel),
});

new SessionListView(
  $<HTMLUListElement>('session-list'),
  $<HTMLElement>('session-count'),
  state,
  (id) => void api.close(id),
);

state.subscribe(syncTerminals);
api.onSessionsChanged((sessions) => state.setSessions(sessions));
api.onData(({ id, data }) => terminals.get(id)?.write(data));
api.onExit(({ id }) => terminals.get(id)?.write('\r\n\x1b[33m[工作階段已結束]\x1b[0m\r\n'));

window.addEventListener('resize', () => activeTerminal()?.resize());

void api.list().then((sessions) => state.setSessions(sessions));
