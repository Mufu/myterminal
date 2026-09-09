import { describe, it, expect, beforeEach } from 'vitest';
import { AppState } from '../src/renderer/app-state';
import type { SessionInfo } from '../src/shared/session';
import type { SavedProfile } from '../src/shared/profile';

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  name: id.toUpperCase(),
  type: 'powershell',
  state: 'running',
  logging: false,
  ...over,
});

let state: AppState;

beforeEach(() => {
  state = new AppState();
});

describe('AppState 訂閱', () => {
  it('狀態改變時通知訂閱者 (Observer)', () => {
    let notified = 0;
    state.subscribe(() => (notified += 1));
    state.setSessions([session('a')]);
    expect(notified).toBe(1);
  });

  it('unsubscribe 之後不再收到通知', () => {
    let notified = 0;
    const off = state.subscribe(() => (notified += 1));
    off();
    state.setSessions([session('a')]);
    expect(notified).toBe(0);
  });
});

describe('AppState 工作階段清單', () => {
  it('初始沒有工作階段也沒有作用中的 id', () => {
    expect(state.sessions).toEqual([]);
    expect(state.activeSessionId).toBeNull();
    expect(state.activeSession()).toBeNull();
  });

  it('第一次收到清單時自動選取最後一個', () => {
    state.setSessions([session('a'), session('b')]);
    expect(state.activeSessionId).toBe('b');
  });

  it('已有作用中的工作階段時，更新清單不會亂跳', () => {
    state.setSessions([session('a'), session('b')]);
    state.setActive('a');
    state.setSessions([session('a'), session('b'), session('c')]);
    expect(state.activeSessionId).toBe('a');
  });

  it('作用中的工作階段被移除後改選最後一個', () => {
    state.setSessions([session('a'), session('b')]);
    state.setActive('a');
    state.setSessions([session('b')]);
    expect(state.activeSessionId).toBe('b');
  });

  it('清單清空後作用中的 id 變回 null', () => {
    state.setSessions([session('a')]);
    state.setSessions([]);
    expect(state.activeSessionId).toBeNull();
  });

  it('activeSession 回傳完整資訊', () => {
    state.setSessions([session('a', { logging: true })]);
    expect(state.activeSession()?.logging).toBe(true);
  });

  it('setActive 到不存在的 id 會被忽略', () => {
    state.setSessions([session('a')]);
    state.setActive('nope');
    expect(state.activeSessionId).toBe('a');
  });

  it('setActive 到同一個 id 不會重複通知', () => {
    state.setSessions([session('a')]);
    let notified = 0;
    state.subscribe(() => (notified += 1));
    state.setActive('a');
    expect(notified).toBe(0);
  });
});

describe('AppState 輸入面板', () => {
  it('預設隱藏，toggle 會切換並通知', () => {
    let notified = 0;
    state.subscribe(() => (notified += 1));
    expect(state.inputPanelVisible).toBe(false);
    state.toggleInputPanel();
    expect(state.inputPanelVisible).toBe(true);
    state.toggleInputPanel();
    expect(state.inputPanelVisible).toBe(false);
    expect(notified).toBe(2);
  });
});

describe('AppState 已儲存連線', () => {
  const profile: SavedProfile = { type: 'powershell', name: '我的 PS' };

  it('初始是空清單', () => {
    expect(state.profiles).toEqual([]);
  });

  it('setProfiles 換掉清單並通知訂閱者 (Observer)', () => {
    let notified = 0;
    state.subscribe(() => (notified += 1));
    state.setProfiles([profile]);
    expect(state.profiles).toEqual([profile]);
    expect(notified).toBe(1);
  });

  it('已儲存連線與工作階段互不影響', () => {
    state.setProfiles([profile]);
    state.setSessions([session('a')]);
    expect(state.profiles).toEqual([profile]);
    expect(state.activeSessionId).toBe('a');
  });
});
