import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeCodeRunner, CodexRunner } from '../src/main/agent-runner';
import type { IAgentRunner } from '../src/main/agent-runner';
import { FakeProcessSpawner } from './fakes/fake-process';
import type { AgentEvent, AgentTask } from '../src/shared/agent';

const fixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

let spawner: FakeProcessSpawner;

beforeEach(() => {
  spawner = new FakeProcessSpawner();
});

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  kind: 'claude',
  prompt: '只回覆 AGENT_SPIKE_OK，不要做別的事',
  cwd: 'C:/tmp',
  allowEdits: false,
  ...over,
});

/** 跑一次：餵 stdout、結束行程，回傳收到的所有事件。*/
function run(runner: IAgentRunner, t: AgentTask, stdout: string, exitCode = 0): AgentEvent[] {
  const events: AgentEvent[] = [];
  runner.start(t).onEvent((event) => events.push(event));
  spawner.last().emitStdout(stdout);
  spawner.last().emitExit(exitCode);
  return events;
}

describe('ClaudeCodeRunner 組出來的命令列', () => {
  it('用 stream-json + --verbose，提示走 stdin', () => {
    new ClaudeCodeRunner(spawner).start(task());
    const spec = spawner.last().spec;

    expect(spec.file).toBe('claude');
    expect(spec.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'plan',
    ]);
    expect(spec.cwd).toBe('C:/tmp');
    expect(spec.stdin).toBe('只回覆 AGENT_SPIKE_OK，不要做別的事');
  });

  it('allowEdits 換成 acceptEdits，resumeId 加上 --resume', () => {
    new ClaudeCodeRunner(spawner).start(task({ allowEdits: true, resumeId: 'abc-123' }));
    expect(spawner.last().spec.args).toContain('acceptEdits');
    expect(spawner.last().spec.args.slice(-2)).toEqual(['--resume', 'abc-123']);
  });
});

describe('ClaudeCodeRunner 解析真實輸出', () => {
  it('把 test/fixtures/claude-stream-json.jsonl 轉成 init + text + result', () => {
    const events = run(new ClaudeCodeRunner(spawner), task(), fixture('claude-stream-json.jsonl'));

    expect(events).toEqual([
      { type: 'init', sessionId: 'a7c9c5c6-ae75-4090-9d47-13fc2c0f23b7' },
      { type: 'text', text: 'AGENT_SPIKE_OK' },
      {
        type: 'result',
        ok: true,
        text: 'AGENT_SPIKE_OK',
        sessionId: 'a7c9c5c6-ae75-4090-9d47-13fc2c0f23b7',
        durationMs: 2664,
        costUsd: 0.07480450000000001,
        exitCode: 0,
      },
    ]);
  });

  it('tool_use 變成 tool 事件，摘要取輸入裡的檔名', () => {
    const events = run(
      new ClaudeCodeRunner(spawner),
      task(),
      fixture('claude-stream-json-tools.jsonl'),
    );

    expect(events.filter((e) => e.type === 'tool')).toEqual([
      {
        type: 'tool',
        name: 'Read',
        // 超過 60 字元的摘要會被截斷，終端機一行放得下。
        summary: 'C:\\Users\\robert_ma\\AppData\\Local\\Temp\\agent-spike-670\\hello…',
      },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'result', ok: true, text: 'AGENT_SPIKE_FILE_OK' });
  });
});

describe('CodexRunner 組出來的命令列', () => {
  it('走 cmd.exe /c (codex 是 .cmd shim)，預設 read-only 且不需要 git repo', () => {
    new CodexRunner(spawner).start(task({ kind: 'codex' }));
    const spec = spawner.last().spec;

    expect(spec.file).toBe('cmd.exe');
    expect(spec.args).toEqual([
      '/c',
      'codex',
      'exec',
      '--sandbox',
      'read-only',
      '--json',
      '--skip-git-repo-check',
      '-c',
      'approval_policy="never"',
    ]);
    expect(spec.stdin).toBe('只回覆 AGENT_SPIKE_OK，不要做別的事');
  });

  it('allowEdits 換成 workspace-write', () => {
    new CodexRunner(spawner).start(task({ kind: 'codex', allowEdits: true }));
    expect(spawner.last().spec.args).toContain('workspace-write');
  });

  it('resumeId 走 exec resume，沙箱只能用 -c sandbox_mode 覆寫', () => {
    new CodexRunner(spawner).start(task({ kind: 'codex', resumeId: 'thread-9' }));
    expect(spawner.last().spec.args).toEqual([
      '/c',
      'codex',
      'exec',
      'resume',
      'thread-9',
      '-c',
      'sandbox_mode="read-only"',
      '--json',
      '--skip-git-repo-check',
      '-c',
      'approval_policy="never"',
    ]);
  });
});

describe('CodexRunner 解析真實輸出', () => {
  it('把 test/fixtures/codex-exec-json.jsonl (真的失敗過的一次) 轉成 init + 失敗 result', () => {
    const events = run(
      new CodexRunner(spawner),
      task({ kind: 'codex' }),
      fixture('codex-exec-json.jsonl'),
      1,
    );

    expect(events[0]).toEqual({ type: 'init', sessionId: '01a08436-5df0-7771-8b1e-3542567d3dc7' });
    expect(events.at(-1)).toMatchObject({ type: 'result', ok: false, exitCode: 1 });
    expect((events.at(-1) as { text: string }).text).toContain('does not exist or you do not have');
    // 重試中的頂層 error 行是雜訊，不該冒出來。
    expect(events).toHaveLength(2);
  });

  // 這台機器的 ChatGPT 帳號拿不到任何 codex 模型 (見 docs/AGENT-SPIKE.md)，
  // 所以成功路徑的事件是照 codex exec --json 的結構寫的，不是抓下來的。
  it('成功路徑：agent_message 變 text、command_execution 變 tool、turn.completed 收尾', () => {
    const lines = [
      '{"type":"thread.started","thread_id":"t-1"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"想一下"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls -la","exit_code":0}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"AGENT_SPIKE_OK"}}',
      '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}',
    ].join('\n');

    const events = run(new CodexRunner(spawner), task({ kind: 'codex' }), lines);

    expect(events).toEqual([
      { type: 'init', sessionId: 't-1' },
      { type: 'tool', name: 'command', summary: 'ls -la' },
      { type: 'text', text: 'AGENT_SPIKE_OK' },
      // turn.completed 沒有結果文字，用最後一段 assistant 文字補上。
      { type: 'result', ok: true, text: 'AGENT_SPIKE_OK', sessionId: 't-1', exitCode: 0 },
    ]);
  });
});

describe('JSONL 解析的邊界情況', () => {
  const claudeLines = fixture('claude-stream-json.jsonl');

  it('chunk 切在一行中間也解析得出來', () => {
    const events: AgentEvent[] = [];
    new ClaudeCodeRunner(spawner).start(task()).onEvent((e) => events.push(e));

    // 每 37 個字元切一刀，故意讓每個 chunk 都不是完整的行。
    for (let i = 0; i < claudeLines.length; i += 37) {
      spawner.last().emitStdout(claudeLines.slice(i, i + 37));
    }
    spawner.last().emitExit(0);

    expect(events.map((e) => e.type)).toEqual(['init', 'text', 'result']);
  });

  it('最後一行沒有換行也不會漏掉', () => {
    const events = run(new ClaudeCodeRunner(spawner), task(), claudeLines.trimEnd());
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'AGENT_SPIKE_OK' });
  });

  it('不是 JSON 的雜訊行直接跳過', () => {
    const events = run(
      new ClaudeCodeRunner(spawner),
      task(),
      ['Reading prompt from stdin...', '', '<<< 亂碼 >>>', ...claudeLines.split('\n')].join('\n'),
    );
    expect(events.map((e) => e.type)).toEqual(['init', 'text', 'result']);
  });

  it('沒有結果事件就結束時，用 stderr 的最後一行當錯誤訊息', () => {
    const events: AgentEvent[] = [];
    new ClaudeCodeRunner(spawner).start(task()).onEvent((e) => events.push(e));
    spawner.last().emitStderr('Error: When using --print, stream-json requires --verbose\n');
    spawner.last().emitExit(1);

    expect(events).toEqual([
      {
        type: 'error',
        message: 'Error: When using --print, stream-json requires --verbose',
      },
    ]);
  });

  it('cancel 會 kill 行程並回報已取消', () => {
    const events: AgentEvent[] = [];
    const run = new ClaudeCodeRunner(spawner).start(task());
    run.onEvent((e) => events.push(e));

    run.cancel();
    spawner.last().emitExit(1);

    expect(spawner.last().killed).toBe(true);
    expect(events).toEqual([{ type: 'error', message: '已取消' }]);
  });
});
