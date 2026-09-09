import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import type { AgentTaskProfile, ConnectionProfile } from '../shared/profile';
import { TYPE_LABELS } from '../shared/profile';
import type { SessionInfo } from '../shared/session';
import type { DataEvent, ExitEvent } from '../shared/ipc';
import type { IPtyProcess, IPtySpawner } from './pty';
import { ShellFactory } from './shell-factory';
import type { IAgentRunnerFactory } from './agent-runner';
import { defaultAgentRunners } from './agent-runner';
import { AgentRunPty } from './agent-run-pty';

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
  ) {
    super();
  }

  create(profile: ConnectionProfile, cols: number, rows: number): SessionInfo {
    this.counter += 1;
    const id = `s${this.counter}`;
    const info: SessionInfo = {
      id,
      name: profile.name?.trim() || `${TYPE_LABELS[profile.type]} ${this.counter}`,
      type: profile.type,
      state: 'running',
      logging: false,
      cwd: profile.cwd,
    };
    const { pty, startupCommand } = this.open(profile, info, cols, rows);

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

    if (startupCommand) {
      // 稍等 shell 起來再送，避免指令被還沒開始讀 stdin 的 shell 吃掉。
      this.schedule(() => pty.write(`${startupCommand}\r`), STARTUP_DELAY_MS);
    }

    this.emit('created', info);
    return info;
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
      return { pty: this.spawner.spawn(spec, cols, rows), startupCommand: spec.startupCommand };
    }
    return { pty: this.startAgent(profile, info) };
  }

  /** agent 任務：開一次 CLI 執行，包成 pty 的樣子。*/
  private startAgent(profile: AgentTaskProfile, info: SessionInfo): IPtyProcess {
    const cwd = profile.cwd?.trim() || homedir();
    info.cwd = cwd;
    info.agentKind = profile.kind;

    const run = this.agents(profile.kind).start({
      kind: profile.kind,
      prompt: profile.prompt,
      cwd,
      allowEdits: profile.allowEdits,
    });
    // CLI 一開始就會報 session id，記下來右側清單才能顯示「接手」。
    run.onEvent((event) => {
      const sessionId =
        event.type === 'init' || event.type === 'result' ? event.sessionId : undefined;
      if (!sessionId || info.agentSessionId === sessionId) return;
      info.agentSessionId = sessionId;
      this.emit('updated', { ...info });
    });
    return new AgentRunPty(run, profile.kind, profile.prompt);
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
