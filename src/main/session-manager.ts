import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { AgentTaskProfile, ConnectionProfile } from '../shared/profile';
import { TYPE_LABELS } from '../shared/profile';
import type { AgentEvent, AgentKind, AgentPermission } from '../shared/agent';
import type { BillingMode } from '../shared/cli-auth';
import { findRole } from '../shared/roles';
import type { SessionInfo } from '../shared/session';
import type { DataEvent, ExitEvent } from '../shared/ipc';
import type { IPtyProcess, IPtySpawner } from './pty';
import { ShellFactory } from './shell-factory';
import type { IAgentRun, IAgentRunnerFactory } from './agent-runner';
import { defaultAgentRunners } from './agent-runner';
import { AgentRunPty } from './agent-run-pty';

/** adoptAgentRun 需要知道的東西：畫面上叫什麼、哪個 CLI、提示與工作目錄。*/
export interface AdoptSpec {
  name: string;
  kind: AgentKind;
  prompt: string;
  cwd: string;
  permission: AgentPermission;
}

interface Session {
  info: SessionInfo;
  pty: IPtyProcess;
}

/** SessionManager 對外發出的事件 (Observer)。*/
type SessionEvents = {
  data: [DataEvent];
  exit: [ExitEvent];
  created: [SessionInfo];
  /** 已經存在的工作階段內容改變 (目前只有 agent 回報了 session id)。*/
  updated: [SessionInfo];
  closed: [string];
};

/** 延遲執行的縫線：測試注入同步版本，正式環境用 setTimeout。*/
export type Scheduler = (fn: () => void, ms: number) => void;

const STARTUP_DELAY_MS = 600;

/**
 * SessionManager — Observer (typed EventEmitter)。
 * 擁有所有工作階段的生命週期；透過注入的 IPtySpawner 與外界隔離，
 * 因此整個類別可以在沒有真實 shell 的情況下被單元測試。
 */
export class SessionManager extends EventEmitter<SessionEvents> {
  private readonly sessions = new Map<string, Session>();
  private counter = 0;

  constructor(
    private readonly spawner: IPtySpawner,
    private readonly factory: ShellFactory = new ShellFactory(),
    private readonly schedule: Scheduler = (fn, ms) => {
      setTimeout(fn, ms);
    },
    private readonly agents: IAgentRunnerFactory = defaultAgentRunners,
    /** CLI 的登入方式；開機探測完才知道，所以注入的是一個取值函式。*/
    private readonly billing: (kind: AgentKind) => BillingMode = () => 'unknown',
    /** 工作目錄存不存在的縫線，測試注入假的。*/
    private readonly exists: (path: string) => boolean = existsSync,
  ) {
    super();
  }

  create(profile: ConnectionProfile, cols: number, rows: number): SessionInfo {
    const id = this.nextId();
    const info: SessionInfo = {
      id,
      name: profile.name?.trim() || `${TYPE_LABELS[profile.type]} ${this.counter}`,
      type: profile.type,
      state: 'running',
      logging: false,
      cwd: profile.cwd,
    };
    const { pty, startupCommand } = this.open(profile, info, cols, rows);
    this.register(info, pty);

    if (startupCommand) {
      // 稍等 shell 起來再送，避免指令被還沒開始讀 stdin 的 shell 吃掉。
      this.schedule(() => pty.write(`${startupCommand}\r`), STARTUP_DELAY_MS);
    }

    this.emit('created', info);
    return info;
  }

  /**
   * 工作流的節點：CLI 執行已經由編排層開好了，這裡只把它登記成一個普通的
   * 工作階段 —— 右側清單、切換、關閉、紀錄、接手全部照舊。
   */
  adoptAgentRun(run: IAgentRun, spec: AdoptSpec): SessionInfo {
    const info: SessionInfo = {
      id: this.nextId(),
      name: spec.name,
      type: 'agent',
      state: 'running',
      logging: false,
      cwd: spec.cwd,
      agentKind: spec.kind,
      permission: spec.permission,
    };
    this.watchAgentSessionId(run, info);
    this.register(
      info,
      new AgentRunPty(run, spec.kind, spec.prompt, this.billing(spec.kind), spec.permission),
    );
    this.emit('created', info);
    return info;
  }

  private nextId(): string {
    this.counter += 1;
    return `s${this.counter}`;
  }

  /** 把 pty 接上事件流並收進清單；create 與 adoptAgentRun 共用。*/
  private register(info: SessionInfo, pty: IPtyProcess): void {
    const id = info.id;
    this.sessions.set(id, { info, pty });

    pty.onData((data) => this.emit('data', { id, data }));
    pty.onExit(({ exitCode }) => {
      const session = this.sessions.get(id);
      if (session) {
        session.info.state = 'exited';
        session.info.exitCode = exitCode;
      }
      this.emit('exit', { id, exitCode });
    });
  }

  /**
   * 開出這個工作階段的「pty」。
   * 一般型別走 ShellFactory + node-pty；agent 任務走 IAgentRunner，
   * 再用 AgentRunPty 包成 IPtyProcess，後面的流程就完全一樣了。
   */
  private open(
    profile: ConnectionProfile,
    info: SessionInfo,
    cols: number,
    rows: number,
  ): { pty: IPtyProcess; startupCommand?: string } {
    if (profile.type !== 'agent') {
      const spec = this.factory.create(profile);
      // node-pty 對這兩種情況只會回「error code: 267」或「File not found: 」，
      // 使用者看不出是自己的哪一欄填錯了。
      if (spec.cwd && !this.exists(spec.cwd)) throw new Error(`工作目錄不存在：${spec.cwd}`);
      if (!spec.file.trim()) throw new Error('請輸入執行檔');
      if (/[\\/]/.test(spec.file) && !this.exists(spec.file)) {
        throw new Error(`找不到執行檔：${spec.file}`);
      }
      try {
        return { pty: this.spawner.spawn(spec, cols, rows), startupCommand: spec.startupCommand };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`無法啟動 ${spec.file}：${reason}`);
      }
    }
    return { pty: this.startAgent(profile, info) };
  }

  /** agent 任務：開一次 CLI 執行，包成 pty 的樣子。*/
  private startAgent(profile: AgentTaskProfile, info: SessionInfo): IPtyProcess {
    const cwd = profile.cwd?.trim() || homedir();
    info.cwd = cwd;
    info.agentKind = profile.kind;
    info.role = profile.role;
    info.permission = profile.permission;

    // 工作目錄不存在時 spawn 只會丟 ENOENT，看不出是目錄的問題。
    if (!this.exists(cwd)) {
      const failed = new FailedRun(`工作目錄不存在：${cwd}`);
      return new AgentRunPty(
        failed,
        profile.kind,
        profile.prompt,
        this.billing(profile.kind),
        profile.permission,
      );
    }

    const run = this.agents(profile.kind).start({
      kind: profile.kind,
      prompt: profile.prompt,
      cwd,
      permission: profile.permission,
      systemPrompt: profile.role ? findRole(profile.role)?.systemPrompt : undefined,
    });
    this.watchAgentSessionId(run, info);
    return new AgentRunPty(
      run,
      profile.kind,
      profile.prompt,
      this.billing(profile.kind),
      profile.permission,
    );
  }

  /** CLI 一開始就會報 session id，記下來右側清單才能顯示「接手」。*/
  private watchAgentSessionId(run: IAgentRun, info: SessionInfo): void {
    run.onEvent((event) => {
      const sessionId =
        event.type === 'init' || event.type === 'result' ? event.sessionId : undefined;
      if (!sessionId || info.agentSessionId === sessionId) return;
      info.agentSessionId = sessionId;
      this.emit('updated', { ...info });
    });
  }

  write(id: string, data: string): void {
    this.running(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    // FitAddon 在容器被隱藏時會量出 0 或 NaN，送進 conpty 會丟例外。
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
    this.running(id)?.pty.resize(cols, rows);
  }

  /** 只有還在跑的工作階段能被寫入或改尺寸；已結束的 pty 再碰會丟例外。*/
  private running(id: string): Session | undefined {
    const session = this.sessions.get(id);
    return session?.info.state === 'running' ? session : undefined;
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.info.state === 'running') session.pty.kill();
    this.sessions.delete(id);
    this.emit('closed', id);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  setLogging(id: string, logging: boolean): void {
    const session = this.sessions.get(id);
    if (session) session.info.logging = logging;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }));
  }
}

/**
 * 還沒開始就註定失敗的執行 (目前只有「工作目錄不存在」)：不 spawn 任何東西，
 * 直接以結果事件收場，畫面上就跟 CLI 自己回報失敗一樣。
 */
class FailedRun implements IAgentRun {
  constructor(private readonly message: string) {}

  onEvent(listener: (event: AgentEvent) => void): void {
    // 等 SessionManager 把 pty 登記好再發，不然結束事件會早於工作階段本身。
    queueMicrotask(() =>
      listener({ type: 'result', ok: false, text: this.message, exitCode: 1 }),
    );
  }

  cancel(): void {}
}
