import type { AgentEvent, AgentKind, AgentTask } from '../shared/agent';
import type { IChildProcess, IProcessSpawner, ProcessSpec } from './process-spawner';
import { NodeProcessSpawner } from './process-spawner';

export interface IAgentRun {
  onEvent(listener: (event: AgentEvent) => void): void;
  cancel(): void;
}

export interface IAgentRunner {
  start(task: AgentTask): IAgentRun;
}

/** SessionManager 用來挑 runner；正式環境是 defaultAgentRunners。*/
export type IAgentRunnerFactory = (kind: AgentKind) => IAgentRunner;

/** 把 CLI 的一行 JSON 映成 0..n 個 AgentEvent。純函式，好測。*/
type EventMapper = (line: Record<string, unknown>) => AgentEvent[];

type ResultEvent = Extract<AgentEvent, { type: 'result' }>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * 一次 CLI 執行。負責「位元組 -> 事件」這段共通的東西：
 * 行緩衝 (chunk 可能切在一行中間)、跳過不是 JSON 的雜訊行、
 * 以及把終端事件壓到行程真的結束時才發出 —— 因為 exitCode 那時才知道。
 */
class JsonlRun implements IAgentRun {
  private readonly listeners: Array<(event: AgentEvent) => void> = [];
  private readonly child: IChildProcess;
  private buffer = '';
  private stderr = '';
  private lastText = '';
  private sessionId?: string;
  private pending?: ResultEvent;
  private cancelled = false;
  private finished = false;

  constructor(
    spawner: IProcessSpawner,
    spec: ProcessSpec,
    private readonly map: EventMapper,
  ) {
    this.child = spawner.spawn(spec);
    this.child.onStdout((chunk) => this.consume(chunk));
    this.child.onStderr((chunk) => {
      this.stderr += chunk;
    });
    this.child.onExit((exitCode) => this.finish(exitCode));
  }

  onEvent(listener: (event: AgentEvent) => void): void {
    this.listeners.push(listener);
  }

  cancel(): void {
    this.cancelled = true;
    this.child.kill();
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // 最後一段可能是半行，留到下一個 chunk。
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // CLI 偶爾會夾雜非 JSON 的提示行，忽略。
    }
    const record = obj(parsed);
    if (!record) return;

    for (const event of this.map(record)) {
      if (event.type === 'result') {
        this.pending = event;
        continue;
      }
      if (event.type === 'init') this.sessionId = event.sessionId;
      if (event.type === 'text') this.lastText = event.text;
      this.emit(event);
    }
  }

  private finish(exitCode: number): void {
    if (this.finished) return;
    this.finished = true;
    this.handleLine(this.buffer);
    this.buffer = '';

    if (this.cancelled) {
      this.emit({ type: 'error', message: '已取消' });
      return;
    }
    if (this.pending) {
      this.emit({
        ...this.pending,
        text: this.pending.text || this.lastText,
        sessionId: this.pending.sessionId ?? this.sessionId,
        exitCode,
      });
      return;
    }
    const tail = this.stderr.trim().split('\n').at(-1) ?? '';
    this.emit({
      type: 'error',
      message: tail || `CLI 沒有回報結果 (exit ${exitCode})`,
    });
  }
}

/** 工具事件的一行摘要：挑輸入裡最能說明「動了什麼」的那個欄位。*/
const SUMMARY_KEYS = ['file_path', 'command', 'pattern', 'url', 'path', 'description'];

function toolSummary(input: unknown): string {
  const record = obj(input);
  if (!record) return '';
  for (const key of SUMMARY_KEYS) {
    const value = str(record[key]);
    if (value) return oneLine(value);
  }
  return '';
}

/** 壓成一行並截短，讓終端機一行放得下。*/
export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/** claude -p --output-format stream-json --verbose 的事件。*/
export const claudeEvents: EventMapper = (line) => {
  switch (line.type) {
    case 'system': {
      const sessionId = str(line.session_id);
      return line.subtype === 'init' && sessionId ? [{ type: 'init', sessionId }] : [];
    }

    case 'assistant': {
      const message = obj(line.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const events: AgentEvent[] = [];
      for (const raw of content) {
        const block = obj(raw);
        if (!block) continue;
        if (block.type === 'text') {
          const text = str(block.text)?.trim();
          if (text) events.push({ type: 'text', text });
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'tool',
            name: str(block.name) ?? 'tool',
            summary: toolSummary(block.input),
          });
        }
      }
      return events;
    }

    case 'result':
      return [
        {
          type: 'result',
          ok: line.subtype === 'success' && line.is_error !== true,
          text: str(line.result) ?? '',
          sessionId: str(line.session_id),
          durationMs: num(line.duration_ms),
          costUsd: num(line.total_cost_usd),
          exitCode: 0, // JsonlRun 會用真正的 exit code 覆寫。
        },
      ];

    default:
      return [];
  }
};

/**
 * codex exec --json 的事件。
 * 頂層的 {"type":"error"} 是連線重試的雜訊 (一次失敗會印五行)，
 * 真正的失敗原因在 turn.failed 裡，所以這裡不轉送。
 */
export const codexEvents: EventMapper = (line) => {
  switch (line.type) {
    case 'thread.started': {
      const sessionId = str(line.thread_id);
      return sessionId ? [{ type: 'init', sessionId }] : [];
    }

    case 'item.completed': {
      const item = obj(line.item);
      if (!item) return [];
      if (item.type === 'agent_message') {
        const text = str(item.text)?.trim();
        return text ? [{ type: 'text', text }] : [];
      }
      if (item.type === 'command_execution') {
        return [{ type: 'tool', name: 'command', summary: oneLine(str(item.command) ?? '') }];
      }
      if (item.type === 'file_change') {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const paths = changes.map((c) => str(obj(c)?.path) ?? '').filter(Boolean);
        return [{ type: 'tool', name: 'file_change', summary: oneLine(paths.join(', ')) }];
      }
      return [];
    }

    case 'turn.completed':
      return [{ type: 'result', ok: true, text: '', exitCode: 0 }];

    case 'turn.failed':
      return [
        {
          type: 'result',
          ok: false,
          text: str(obj(line.error)?.message) ?? '',
          exitCode: 0,
        },
      ];

    default:
      return [];
  }
};

/**
 * ClaudeCodeRunner — Adapter，把 AgentTask 變成一次 claude -p 執行。
 * stream-json 在 print 模式下一定要配 --verbose，否則 claude 直接拒絕啟動。
 */
export class ClaudeCodeRunner implements IAgentRunner {
  constructor(private readonly spawner: IProcessSpawner = new NodeProcessSpawner()) {}

  start(task: AgentTask): IAgentRun {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    // plan 模式仍然會讀檔與回答，只是不能寫；比 --tools "" 有用得多。
    args.push('--permission-mode', task.allowEdits ? 'acceptEdits' : 'plan');
    if (task.resumeId) args.push('--resume', task.resumeId);
    return new JsonlRun(
      this.spawner,
      { file: 'claude', args, cwd: task.cwd, stdin: task.prompt },
      claudeEvents,
    );
  }
}

/**
 * CodexRunner — 同上，但走 codex exec。
 * codex 是 .cmd shim，一定要透過 cmd.exe /c 才 spawn 得起來 (見 process-spawner.ts)。
 * exec resume 沒有 --sandbox，只能用 -c sandbox_mode 覆寫。
 */
export class CodexRunner implements IAgentRunner {
  constructor(private readonly spawner: IProcessSpawner = new NodeProcessSpawner()) {}

  start(task: AgentTask): IAgentRun {
    const sandbox = task.allowEdits ? 'workspace-write' : 'read-only';
    const args = ['/c', 'codex', 'exec'];
    if (task.resumeId) args.push('resume', task.resumeId, '-c', `sandbox_mode="${sandbox}"`);
    else args.push('--sandbox', sandbox);
    args.push('--json', '--skip-git-repo-check', '-c', 'approval_policy="never"');
    return new JsonlRun(
      this.spawner,
      { file: 'cmd.exe', args, cwd: task.cwd, stdin: task.prompt },
      codexEvents,
    );
  }
}

export const defaultAgentRunners: IAgentRunnerFactory = (kind) =>
  kind === 'claude' ? new ClaudeCodeRunner() : new CodexRunner();
