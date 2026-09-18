import type { SessionInfo } from '../shared/session';
import type { SavedProfile } from '../shared/profile';
import type { RunState } from '../shared/workflow';
import type { CliAuthSetting, CliAuthStatus, CliId } from '../shared/cli-auth';

type Listener = () => void;

/** 中間那一塊顯示什麼：終端機，或是工作流的畫布編輯器。*/
export type MainView = 'terminal' | 'editor';

/**
 * AppState — renderer 端唯一的狀態來源，Observer。
 * 各個 View 訂閱它並在通知時重畫；Command 只透過它讀取目前作用中的工作階段。
 */
export class AppState {
  private listeners = new Set<Listener>();
  private _sessions: SessionInfo[] = [];
  private _activeSessionId: string | null = null;
  private _inputPanelVisible = false;
  private _profiles: SavedProfile[] = [];
  private _runs: RunState[] = [];
  private _cliAuth: CliAuthStatus | null = null;
  private _cliSettings: Record<CliId, CliAuthSetting> | null = null;
  private _cliProbing = false;
  private _view: MainView = 'terminal';

  get sessions(): SessionInfo[] {
    return this._sessions;
  }

  get activeSessionId(): string | null {
    return this._activeSessionId;
  }

  get inputPanelVisible(): boolean {
    return this._inputPanelVisible;
  }

  get profiles(): SavedProfile[] {
    return this._profiles;
  }

  get runs(): RunState[] {
    return this._runs;
  }

  /** 四支 CLI 實際的登入狀態；探測回來之前是 null。*/
  get cliAuth(): CliAuthStatus | null {
    return this._cliAuth;
  }

  /** 使用者在「CLI 設定」裡選的登入方式；讀回來之前是 null。*/
  get cliSettings(): Record<CliId, CliAuthSetting> | null {
    return this._cliSettings;
  }

  /** 正在探四支 CLI 的登入狀態；這段期間晶片上寫「偵測中…」。*/
  get cliProbing(): boolean {
    return this._cliProbing;
  }

  get view(): MainView {
    return this._view;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSessions(sessions: SessionInfo[]): void {
    this._sessions = sessions;
    // 作用中的工作階段不見了 (或還沒選) 就改選最後一個 —— 新建的通常在最後。
    if (!sessions.some((s) => s.id === this._activeSessionId)) {
      this._activeSessionId = sessions.at(-1)?.id ?? null;
    }
    this.notify();
  }

  setActive(id: string): void {
    if (id === this._activeSessionId) return;
    if (!this._sessions.some((s) => s.id === id)) return;
    this._activeSessionId = id;
    this.notify();
  }

  activeSession(): SessionInfo | null {
    return this._sessions.find((s) => s.id === this._activeSessionId) ?? null;
  }

  setProfiles(profiles: SavedProfile[]): void {
    this._profiles = profiles;
    this.notify();
  }

  setRuns(runs: RunState[]): void {
    this._runs = runs;
    this.notify();
  }

  setCliAuth(status: CliAuthStatus): void {
    this._cliAuth = status;
    this.notify();
  }

  setCliSettings(settings: Record<CliId, CliAuthSetting>): void {
    this._cliSettings = settings;
    this.notify();
  }

  setCliProbing(probing: boolean): void {
    if (probing === this._cliProbing) return;
    this._cliProbing = probing;
    this.notify();
  }

  showEditor(): void {
    this.setView('editor');
  }

  showTerminal(): void {
    this.setView('terminal');
  }

  /** 面板要用的時候就打開它；已經開著就什麼都不做。*/
  showInputPanel(): void {
    if (this._inputPanelVisible) return;
    this._inputPanelVisible = true;
    this.notify();
  }

  toggleInputPanel(): void {
    this._inputPanelVisible = !this._inputPanelVisible;
    this.notify();
  }

  private setView(view: MainView): void {
    if (view === this._view) return;
    this._view = view;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
