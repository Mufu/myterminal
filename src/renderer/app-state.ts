import type { SessionInfo } from '../shared/session';
import type { SavedProfile } from '../shared/profile';

type Listener = () => void;

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

  toggleInputPanel(): void {
    this._inputPanelVisible = !this._inputPanelVisible;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
