import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentEvent,
  AgentKind,
  AgentPermission,
  AgentTask,
  TokenUsage,
} from '../shared/agent';
import type { IChildProcess, IProcessSpawner, ProcessSpec } from './process-spawner';
import { NodeProcessSpawner } from './process-spawner';
import type { CliSecrets } from './shell-factory';

/** 沒有注入任何金鑰的預設縫線 (單元測試與 defaultAgentRunners 用)。*/
const NO_SECRETS: CliSecrets = () => ({ env: {} });

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
export class JsonlRun implements IAgentRun {
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
    /** 行程結束之後要收的尾；目前只有 Muse 的提示暫存檔要刪。*/
    private readonly cleanup?: () => void,
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
    this.cleanup?.();
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
const SUMMARY_KEYS = [
  'file_path',
  // opencode 的工具輸入是小駝峰。
  'filePath',
  'command',
  'pattern',
  'url',
  'path',
  'description',
];

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

/**
 * claude 的 result.usage：輸入分成三欄 (新的、寫進快取的、從快取讀的)，
 * 三個都是這次真的吃掉的 token，所以加起來才是輸入量。
 */
function claudeTokens(raw: unknown): TokenUsage | undefined {
  const usage = obj(raw);
  if (!usage) return undefined;
  const input =
    (num(usage.input_tokens) ?? 0) +
    (num(usage.cache_creation_input_tokens) ?? 0) +
    (num(usage.cache_read_input_tokens) ?? 0);
  const output = num(usage.output_tokens) ?? 0;
  return input + output > 0 ? { input, output, total: input + output } : undefined;
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
          tokens: claudeTokens(line.usage),
          exitCode: 0, // JsonlRun 會用真正的 exit code 覆寫。
        },
      ];

    default:
      return [];
  }
};

/**
 * codex 的 turn.completed 帶著 usage (實際抓下來的一次在
 * test/fixtures/codex-exec-json-tokens.jsonl)：
 * {"input_tokens":11936,"cached_input_tokens":1408,"output_tokens":7,"reasoning_output_tokens":0}
 * cached_input_tokens 與 reasoning_output_tokens 分別是那兩個數字的一部分，
 * 所以總數就是 input + output。codex 不回報金額，畫面上寫的就是這個。
 */
function codexTokens(raw: unknown): TokenUsage | undefined {
  const usage = obj(raw);
  const input = num(usage?.input_tokens);
  const output = num(usage?.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  return { input, output, total: (input ?? 0) + (output ?? 0) };
}

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
      return [{ type: 'result', ok: true, text: '', tokens: codexTokens(line.usage), exitCode: 0 }];

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
 * muse exec --json 的事件。每一行都是一筆記錄：型別在 payload_type、內容在
 * payload，session id 則掛在 stream 上 (kind === 'session')。
 *
 * 只有 echo provider 的輸出是實際抓下來的 (test/fixtures/muse-echo-exec.jsonl)，
 * 真的 meta provider 需要 Meta 登入，這台機器沒有 —— 所以工具呼叫長什麼樣子、
 * 有沒有用量欄位都還沒看過，這裡一律防禦性地解析，認不得的就忽略。
 */
export const museEvents: EventMapper = (line) => {
  const type = str(line.payload_type);
  const payload = obj(line.payload);
  if (!type || !payload) return [];

  // 每一行都帶著 session，但 runtime.command.accepted 一次執行只有一筆。
  if (type === 'runtime.command.accepted') {
    const stream = obj(line.stream);
    const sessionId = stream?.kind === 'session' ? str(stream.id) : undefined;
    return sessionId ? [{ type: 'init', sessionId }] : [];
  }

  // 終端事件的 payload_type 是 run.terminal.<結果>，成敗看 terminal 這個欄位。
  if (type.startsWith('run.terminal.')) {
    const ok = payload.terminal === 'completed';
    const text = str(payload.text) ?? '';
    return [{ type: 'result', ok, text: ok ? text : (str(payload.reason) ?? text), exitCode: 0 }];
  }

  switch (type) {
    case 'run.output.delta': {
      const text = str(payload.text)?.trim();
      return text ? [{ type: 'text', text }] : [];
    }

    case 'task.lifecycle.proposed': {
      // model.* 只是模型自己的回合，內容已經以文字出現過了，再印一次是雜訊。
      const kind = str(obj(payload.event)?.task_kind);
      return kind && !kind.startsWith('model.')
        ? [{ type: 'tool', name: kind, summary: '' }]
        : [];
    }

    case 'task.lifecycle.failed': {
      // 單一任務失敗不等於整次執行失敗 (echo provider 的 verify-reminder 必定失敗)，
      // 成敗一律以 run.terminal.* 為準，這裡只把原因顯示出來。
      const reason = str(obj(payload.event)?.reason);
      return reason ? [{ type: 'tool', name: 'task.failed', summary: oneLine(reason) }] : [];
    }

    default:
      return [];
  }
};

/**
 * opencode run --format json 的事件。
 *
 * 它沒有「這次跑完了」那種事件 —— 串流結束就是結束 —— 所以結果是在每個
 * step_finish 上重新湊一份，最後留下來的那筆就是最終結果。費用與 token 要跨 step
 * 累加、結果文字要把每段回覆接起來，所以這個 mapper 有狀態，一次執行配一個
 * (claude / codex 的沒有狀態，是模組常數)。
 */
export function opencodeEvents(): EventMapper {
  let started = false;
  let costUsd = 0;
  const tokens: TokenUsage = { input: 0, output: 0, total: 0 };
  const texts: string[] = [];

  return (line) => {
    const events: AgentEvent[] = [];
    const sessionId = str(line.sessionID);
    // sessionID 每一行都有，第一次看到就當作 init。
    if (!started && sessionId) {
      started = true;
      events.push({ type: 'init', sessionId });
    }
    const part = obj(line.part);

    switch (line.type) {
      case 'text': {
        const text = str(part?.text)?.trim();
        if (text) {
          texts.push(text);
          events.push({ type: 'text', text });
        }
        break;
      }

      case 'tool_use':
        events.push({
          type: 'tool',
          name: str(part?.tool) ?? 'tool',
          summary: toolSummary(obj(part?.state)?.input),
        });
        break;

      case 'step_finish': {
        costUsd += num(part?.cost) ?? 0;
        const step = obj(part?.tokens);
        tokens.input = (tokens.input ?? 0) + (num(step?.input) ?? 0);
        tokens.output = (tokens.output ?? 0) + (num(step?.output) ?? 0);
        // total 是 opencode 自己算的 (含快取讀寫)，所以用它的，不要拿 input + output。
        tokens.total += num(step?.total) ?? 0;
        events.push({
          type: 'result',
          // reason 是 stop (講完了) 或 tool-calls (還要再跑一輪)；error 才是真的壞了。
          ok: str(part?.reason) !== 'error',
          text: texts.join('\n\n'),
          sessionId,
          // 免費模型的 cost 是 0，這時不要在頁尾寫一個 $0.000。
          costUsd: costUsd > 0 ? costUsd : undefined,
          tokens: tokens.total > 0 ? { ...tokens } : undefined,
          exitCode: 0,
        });
        break;
      }

      case 'error': {
        const error = obj(line.error);
        const message = str(obj(error?.data)?.message) ?? str(error?.name) ?? '';
        events.push({ type: 'result', ok: false, text: message, sessionId, exitCode: 0 });
        break;
      }
    }

    return events;
  };
}

/**
 * 權限對應到 claude 的 --permission-mode。
 * acceptEdits 改得了檔案，卻會擋掉 Bash 指令 —— 實測 `claude -p
 * --permission-mode acceptEdits` 下 `git --version` 進了 permission_denials ——
 * 所以要跑測試 (工程師 / 測試工程師) 的節點得用 full。
 * bypassPermissions 實測過：同一句話會真的執行，permission_denials 是空的。
 */
const CLAUDE_MODES: Record<AgentPermission, string> = {
  readonly: 'plan',
  edit: 'acceptEdits',
  full: 'bypassPermissions',
};

/**
 * ClaudeCodeRunner — Adapter，把 AgentTask 變成一次 claude -p 執行。
 * stream-json 在 print 模式下一定要配 --verbose，否則 claude 直接拒絕啟動。
 */
export class ClaudeCodeRunner implements IAgentRunner {
  constructor(
    private readonly spawner: IProcessSpawner = new NodeProcessSpawner(),
    private readonly secrets: CliSecrets = NO_SECRETS,
  ) {}

  start(task: AgentTask): IAgentRun {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    // plan 模式仍然會讀檔與回答，只是不能寫；比 --tools "" 有用得多。
    args.push('--permission-mode', CLAUDE_MODES[task.permission]);
    if (task.systemPrompt) args.push('--append-system-prompt', task.systemPrompt);
    if (task.resumeId) args.push('--resume', task.resumeId);
    return new JsonlRun(
      this.spawner,
      {
        file: 'claude',
        args,
        cwd: task.cwd,
        stdin: task.prompt,
        env: this.secrets('claude', 'powershell').env,
      },
      claudeEvents,
    );
  }
}

/** 權限對應到 codex 的沙箱。*/
const CODEX_SANDBOXES: Record<AgentPermission, string> = {
  readonly: 'read-only',
  edit: 'workspace-write',
  full: 'danger-full-access',
};

/**
 * CodexRunner — 同上，但走 codex exec。
 * codex 是 .cmd shim，一定要透過 cmd.exe /c 才 spawn 得起來 (見 process-spawner.ts)。
 * exec resume 沒有 --sandbox，只能用 -c sandbox_mode 覆寫。
 * 它也沒有 claude 的 --append-system-prompt，所以角色的前置指示只能接在提示前面。
 */
export class CodexRunner implements IAgentRunner {
  constructor(
    private readonly spawner: IProcessSpawner = new NodeProcessSpawner(),
    private readonly secrets: CliSecrets = NO_SECRETS,
  ) {}

  start(task: AgentTask): IAgentRun {
    const sandbox = CODEX_SANDBOXES[task.permission];
    const args = ['/c', 'codex', 'exec'];
    if (task.resumeId) args.push('resume', task.resumeId, '-c', `sandbox_mode="${sandbox}"`);
    else args.push('--sandbox', sandbox);
    args.push('--json', '--skip-git-repo-check', '-c', 'approval_policy="never"');
    return new JsonlRun(
      this.spawner,
      {
        file: 'cmd.exe',
        args,
        cwd: task.cwd,
        stdin: withSystemPrompt(task),
        env: this.secrets('codex', 'powershell').env,
      },
      codexEvents,
    );
  }
}

/**
 * MuseRunner — muse exec。muse 是 %LOCALAPPDATA%\Programs\muse\muse.cmd 這個
 * shim，跟 codex 一樣要走 cmd.exe /c。提示一律寫成暫存檔再用 --prompt-file 讀，
 * 不放進命令列 (換行與引號在 cmd.exe 上一定會出事)，行程結束就刪掉。
 * muse 沒有 claude 的 --append-system-prompt，角色的前置指示只能接在提示前面。
 *
 * 核准模式 (都用 --provider echo 實測過，不會卡住)：
 *   - untrusted：要授權的工具被政策直接擋掉，不是停下來問人；再加
 *     --disable-write 關掉非 shell 的寫檔，等價於 codex 的 read-only。
 *   - never：永遠不問，也就是全部放行 —— edit 與 full 都是這個
 *     (muse 只有這兩檔)。
 * 預設的 on-request 真的有工具要授權時會停下來等人，無介面不能用。
 */
export class MuseRunner implements IAgentRunner {
  constructor(
    private readonly spawner: IProcessSpawner = new NodeProcessSpawner(),
    private readonly secrets: CliSecrets = NO_SECRETS,
  ) {}

  start(task: AgentTask): IAgentRun {
    const file = join(tmpdir(), `myterminal-muse-${randomUUID()}.txt`);
    writeFileSync(file, withSystemPrompt(task), 'utf8');

    const args = ['/c', 'muse', 'exec', '--json', '--prompt-file', file];
    if (task.permission === 'readonly') args.push('--approval-mode', 'untrusted', '--disable-write');
    else args.push('--approval-mode', 'never');
    // muse exec 沒有 resume 子命令，接續是「指定同一個 session id」。
    if (task.resumeId) args.push('--session-id', task.resumeId);

    return new JsonlRun(
      this.spawner,
      { file: 'cmd.exe', args, cwd: task.cwd, env: this.secrets('muse', 'powershell').env },
      museEvents,
      () => rmSync(file, { force: true }),
    );
  }
}

/**
 * OpenCodeRunner — opencode run。它是 %APPDATA%\npm\opencode.cmd，一樣走
 * cmd.exe /c；訊息可以直接從 stdin 讀 (實測過)，所以提示跟 claude 一樣不碰引號。
 *
 * 它沒有「唯讀」旗標 —— `opencode run` 預設就直接寫檔，不問也不擋 ——
 * 但內建的 plan agent 權限是 edit: deny，效果等同 claude 的 plan 模式，
 * 所以 readonly 就換成它 (實測：模型寫不了檔，也不會卡住)。
 * full 再加 --auto：自動核准沒有被明確拒絕的權限。
 */
export class OpenCodeRunner implements IAgentRunner {
  constructor(
    private readonly spawner: IProcessSpawner = new NodeProcessSpawner(),
    private readonly secrets: CliSecrets = NO_SECRETS,
  ) {}

  start(task: AgentTask): IAgentRun {
    const { env, model } = this.secrets('opencode', 'powershell');
    const args = ['/c', 'opencode', 'run', '--format', 'json', '--dir', task.cwd];
    // 「CLI 設定」選了型號就用它，沒選就讓 opencode 用自己的預設。
    // MYTERMINAL_OPENCODE_MODEL 是 e2e 的後門：不用金鑰的免費模型
    // (opencode/mimo-v2.5-free) 的供應商不在「CLI 設定」那張清單裡。
    const chosen = process.env.MYTERMINAL_OPENCODE_MODEL?.trim() || model;
    if (chosen) args.push('-m', chosen);
    if (task.resumeId) args.push('--session', task.resumeId);
    if (task.permission === 'readonly') args.push('--agent', 'plan');
    // --auto 是「什麼都自動核准」；預設的 build agent 只寫檔，不會自己跑指令。
    if (task.permission === 'full') args.push('--auto');

    return new JsonlRun(
      this.spawner,
      { file: 'cmd.exe', args, cwd: task.cwd, stdin: withSystemPrompt(task), env },
      opencodeEvents(),
    );
  }
}

/** 沒有 --append-system-prompt 的 CLI：角色的前置指示只能接在提示前面。*/
function withSystemPrompt(task: AgentTask): string {
  return task.systemPrompt ? `${task.systemPrompt}\n\n${task.prompt}` : task.prompt;
}

/**
 * 正式環境的 runner 工廠。四支 CLI 的無介面執行跟互動式工作階段拿同一份
 * 「CLI 設定」注入 —— 選了 API 金鑰的那支，Agent 任務與工作流節點才有金鑰可用。
 * 無介面一律在 Windows 上原生執行，所以 baseShell 固定是 powershell。
 */
export function agentRunners(
  secrets: CliSecrets = NO_SECRETS,
  spawner: IProcessSpawner = new NodeProcessSpawner(),
): IAgentRunnerFactory {
  return (kind) => {
    switch (kind) {
      case 'claude':
        return new ClaudeCodeRunner(spawner, secrets);
      case 'codex':
        return new CodexRunner(spawner, secrets);
      case 'muse':
        return new MuseRunner(spawner, secrets);
      case 'opencode':
        return new OpenCodeRunner(spawner, secrets);
    }
  };
}

export const defaultAgentRunners: IAgentRunnerFactory = agentRunners();
