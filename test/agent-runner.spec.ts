import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentRunners,
  ClaudeCodeRunner,
  CodexRunner,
  MuseRunner,
  OpenCodeRunner,
} from '../src/main/agent-runner';
import type { IAgentRunner } from '../src/main/agent-runner';
import type { CliSecrets } from '../src/main/shell-factory';
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
  permission: 'readonly',
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

  // acceptEdits 改得了檔案卻擋掉 Bash (實測：git --version 會進 permission_denials)，
  // 所以要跑測試的節點得用 full —— bypassPermissions 實測過不會被擋。
  it.each([
    ['readonly', 'plan'],
    ['edit', 'acceptEdits'],
    ['full', 'bypassPermissions'],
  ] as const)('%s 對應 --permission-mode %s', (permission, mode) => {
    new ClaudeCodeRunner(spawner).start(task({ permission }));
    expect(spawner.last().spec.args.slice(-2)).toEqual(['--permission-mode', mode]);
  });

  it('resumeId 加上 --resume', () => {
    new ClaudeCodeRunner(spawner).start(task({ permission: 'edit', resumeId: 'abc-123' }));
    expect(spawner.last().spec.args.slice(-2)).toEqual(['--resume', 'abc-123']);
  });

  it('角色的前置指示走 --append-system-prompt，排在 --resume 前面', () => {
    new ClaudeCodeRunner(spawner).start(task({ systemPrompt: '你是審查者。', resumeId: 'abc-123' }));
    expect(spawner.last().spec.args.slice(-4)).toEqual([
      '--append-system-prompt',
      '你是審查者。',
      '--resume',
      'abc-123',
    ]);

    // 沒有角色時什麼都不變。
    new ClaudeCodeRunner(spawner).start(task());
    expect(spawner.last().spec.args).not.toContain('--append-system-prompt');
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

  it.each([
    ['readonly', 'read-only'],
    ['edit', 'workspace-write'],
    ['full', 'danger-full-access'],
  ] as const)('%s 對應 --sandbox %s', (permission, sandbox) => {
    new CodexRunner(spawner).start(task({ kind: 'codex', permission }));
    expect(spawner.last().spec.args.slice(3, 5)).toEqual(['--sandbox', sandbox]);
  });

  it.each([
    ['readonly', 'read-only'],
    ['edit', 'workspace-write'],
    ['full', 'danger-full-access'],
  ] as const)('接續時 %s 走 -c sandbox_mode="%s"', (permission, sandbox) => {
    new CodexRunner(spawner).start(task({ kind: 'codex', permission, resumeId: 'thread-9' }));
    expect(spawner.last().spec.args.slice(3, 7)).toEqual([
      'resume',
      'thread-9',
      '-c',
      `sandbox_mode="${sandbox}"`,
    ]);
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

  it('codex 沒有對應的旗標，角色的前置指示接在提示前面一起走 stdin', () => {
    new CodexRunner(spawner).start(task({ kind: 'codex', systemPrompt: '你是審查者。' }));
    expect(spawner.last().spec.args).not.toContain('--append-system-prompt');
    expect(spawner.last().spec.stdin).toBe('你是審查者。\n\n只回覆 AGENT_SPIKE_OK，不要做別的事');

    // 沒有角色時 stdin 就是原本的提示。
    new CodexRunner(spawner).start(task({ kind: 'codex' }));
    expect(spawner.last().spec.stdin).toBe('只回覆 AGENT_SPIKE_OK，不要做別的事');
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

/** muse 的提示在暫存檔裡，不在命令列上。*/
const promptFile = (args: string[]): string => args[args.indexOf('--prompt-file') + 1];

describe('MuseRunner 組出來的命令列', () => {
  it('走 cmd.exe /c，提示寫成暫存檔，唯讀時是 untrusted + --disable-write', () => {
    new MuseRunner(spawner).start(task({ kind: 'muse' }));
    const spec = spawner.last().spec;

    expect(spec.file).toBe('cmd.exe');
    expect(spec.args.slice(0, 4)).toEqual(['/c', 'muse', 'exec', '--json']);
    expect(spec.args.slice(-3)).toEqual(['--approval-mode', 'untrusted', '--disable-write']);
    expect(spec.cwd).toBe('C:/tmp');
    // 提示絕不出現在命令列上 (cmd.exe 的引號規則會把換行與引號吃掉)。
    expect(spec.args).not.toContain('只回覆 AGENT_SPIKE_OK，不要做別的事');
    expect(readFileSync(promptFile(spec.args), 'utf8')).toBe('只回覆 AGENT_SPIKE_OK，不要做別的事');
  });

  // muse 只有「擋掉」跟「全部放行」兩檔，edit 與 full 都是 never。
  it.each([
    ['readonly', ['--approval-mode', 'untrusted', '--disable-write']],
    ['edit', ['--approval-mode', 'never']],
    ['full', ['--approval-mode', 'never']],
  ] as const)('%s 對應 %s', (permission, flags) => {
    new MuseRunner(spawner).start(task({ kind: 'muse', permission }));
    expect(spawner.last().spec.args.slice(-flags.length)).toEqual([...flags]);
  });

  it('resumeId 走 --session-id', () => {
    new MuseRunner(spawner).start(task({ kind: 'muse', permission: 'edit', resumeId: 'ses-1' }));
    expect(spawner.last().spec.args.slice(-2)).toEqual(['--session-id', 'ses-1']);
  });

  it('muse 沒有對應的旗標，角色的前置指示接在提示檔的最前面', () => {
    new MuseRunner(spawner).start(task({ kind: 'muse', systemPrompt: '你是審查者。' }));
    expect(readFileSync(promptFile(spawner.last().spec.args), 'utf8')).toBe(
      '你是審查者。\n\n只回覆 AGENT_SPIKE_OK，不要做別的事',
    );
  });

  it('行程結束之後把提示暫存檔刪掉', () => {
    new MuseRunner(spawner).start(task({ kind: 'muse' }));
    const file = promptFile(spawner.last().spec.args);

    expect(existsSync(file)).toBe(true);
    spawner.last().emitExit(0);
    expect(existsSync(file)).toBe(false);
  });
});

describe('MuseRunner 解析真實輸出', () => {
  it('把 test/fixtures/muse-echo-exec.jsonl (--provider echo) 轉成事件', () => {
    const events = run(new MuseRunner(spawner), task({ kind: 'muse' }), fixture('muse-echo-exec.jsonl'));

    expect(events.map((e) => e.type)).toEqual(['init', 'tool', 'text', 'tool', 'tool', 'result']);
    expect(events[0]).toEqual({
      type: 'init',
      sessionId: '01a0a3e5-b8cf-7cb2-b2eb-53345b54e20c',
    });
    // model.* 那一筆 task.lifecycle.proposed 被濾掉了，只剩下兩個 reminder。
    expect(events[1]).toEqual({ type: 'tool', name: 'reminder.agent.skill-reminder', summary: '' });
    expect(events[2]).toEqual({ type: 'text', text: 'echo: hello from echo' });
    expect(events[3]).toMatchObject({ type: 'tool', name: 'reminder.agent.verify-reminder' });
    // 子任務失敗只是顯示出來；這一次執行整體仍然是成功的。
    expect(events[4]).toMatchObject({ type: 'tool', name: 'task.failed' });
    expect((events[4] as { summary: string }).summary).toMatch(/^invalid run configuration/);
    expect(events[5]).toEqual({
      type: 'result',
      ok: true,
      text: 'echo: hello from echo',
      sessionId: '01a0a3e5-b8cf-7cb2-b2eb-53345b54e20c',
      exitCode: 0,
    });
  });

  // 這台機器沒有 Meta 登入也沒有 META_API_KEY，跑不出真的失敗，
  // 所以這幾行是照 run.terminal.* 的結構寫的，不是抓下來的 (見 docs/AGENT-SPIKE.md)。
  it('run.terminal.failed 變成失敗的 result，訊息取 reason', () => {
    const lines = [
      '{"payload_type":"runtime.command.accepted","stream":{"kind":"session","id":"s-9"},"payload":{"kind":"command_accepted"}}',
      '{"payload_type":"run.terminal.failed","payload":{"kind":"run_terminal","terminal":"failed","text":"","reason":"model provider returned 401"}}',
    ].join('\n');

    const events = run(new MuseRunner(spawner), task({ kind: 'muse' }), lines, 1);

    expect(events).toEqual([
      { type: 'init', sessionId: 's-9' },
      {
        type: 'result',
        ok: false,
        text: 'model provider returned 401',
        sessionId: 's-9',
        exitCode: 1,
      },
    ]);
  });
});

describe('OpenCodeRunner 組出來的命令列', () => {
  it('走 cmd.exe /c，提示走 stdin，唯讀時換成內建的 plan agent', () => {
    new OpenCodeRunner(spawner).start(task({ kind: 'opencode' }));
    const spec = spawner.last().spec;

    expect(spec.file).toBe('cmd.exe');
    expect(spec.args).toEqual([
      '/c',
      'opencode',
      'run',
      '--format',
      'json',
      '--dir',
      'C:/tmp',
      '--agent',
      'plan',
    ]);
    expect(spec.stdin).toBe('只回覆 AGENT_SPIKE_OK，不要做別的事');
  });

  // opencode 預設 (build agent) 就會寫檔，所以 edit 什麼都不必加。
  it.each([
    ['readonly', ['--agent', 'plan']],
    ['edit', []],
    ['full', ['--auto']],
  ] as const)('%s 對應 %s', (permission, flags) => {
    const base = ['/c', 'opencode', 'run', '--format', 'json', '--dir', 'C:/tmp'];
    new OpenCodeRunner(spawner).start(task({ kind: 'opencode', permission }));
    expect(spawner.last().spec.args).toEqual([...base, ...flags]);
  });

  it('resumeId 走 --session', () => {
    new OpenCodeRunner(spawner).start(
      task({ kind: 'opencode', permission: 'edit', resumeId: 'ses_abc' }),
    );
    expect(spawner.last().spec.args.slice(-2)).toEqual(['--session', 'ses_abc']);
  });

  it('「CLI 設定」選了型號就變成 -m provider/model', () => {
    const secrets: CliSecrets = () => ({ env: {}, model: 'anthropic/claude-sonnet-5' });
    new OpenCodeRunner(spawner, secrets).start(task({ kind: 'opencode' }));
    expect(spawner.last().spec.args.slice(7, 9)).toEqual(['-m', 'anthropic/claude-sonnet-5']);
  });

  it('opencode 沒有對應的旗標，角色的前置指示接在提示前面一起走 stdin', () => {
    new OpenCodeRunner(spawner).start(task({ kind: 'opencode', systemPrompt: '你是審查者。' }));
    expect(spawner.last().spec.stdin).toBe('你是審查者。\n\n只回覆 AGENT_SPIKE_OK，不要做別的事');
  });
});

describe('OpenCodeRunner 解析真實輸出', () => {
  it('把 test/fixtures/opencode-run-json.jsonl 轉成 init + text + result', () => {
    const events = run(
      new OpenCodeRunner(spawner),
      task({ kind: 'opencode' }),
      fixture('opencode-run-json.jsonl'),
    );

    expect(events).toEqual([
      { type: 'init', sessionId: 'ses_f5bdbfb99ffeS2oNNEfWwMlzP9' },
      { type: 'text', text: 'OPENCODE_OK' },
      {
        type: 'result',
        ok: true,
        text: 'OPENCODE_OK',
        sessionId: 'ses_f5bdbfb99ffeS2oNNEfWwMlzP9',
        // 免費模型的 cost 是 0，不要在頁尾寫一個 $0.000。
        costUsd: undefined,
        exitCode: 0,
      },
    ]);
  });

  it('工具呼叫變成 tool 事件，多段回覆接起來當結果，費用跨 step 累加', () => {
    const lines = [
      '{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}',
      '{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"read","state":{"status":"completed","input":{"filePath":"C:\\\\tmp\\\\alpha.txt"}}}}',
      '{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","reason":"tool-calls","cost":0.01}}',
      '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"看完了"}}',
      '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"OPENCODE_OK"}}',
      '{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","reason":"stop","cost":0.02}}',
    ].join('\n');

    const events = run(new OpenCodeRunner(spawner), task({ kind: 'opencode' }), lines);

    expect(events).toEqual([
      { type: 'init', sessionId: 'ses_1' },
      { type: 'tool', name: 'read', summary: 'C:\\tmp\\alpha.txt' },
      { type: 'text', text: '看完了' },
      { type: 'text', text: 'OPENCODE_OK' },
      {
        type: 'result',
        ok: true,
        text: '看完了\n\nOPENCODE_OK',
        sessionId: 'ses_1',
        costUsd: 0.03,
        exitCode: 0,
      },
    ]);
  });

  // 指定一個拿不到的型號時真的印出來的那一行 (見 docs/AGENT-SPIKE.md)。
  it('頂層 error 變成失敗的 result，訊息取 error.data.message', () => {
    const line =
      '{"type":"error","sessionID":"ses_2","error":{"name":"APIError","data":{"message":"key not allowed to access model","statusCode":403}}}';

    const events = run(new OpenCodeRunner(spawner), task({ kind: 'opencode' }), line, 1);

    expect(events).toEqual([
      { type: 'init', sessionId: 'ses_2' },
      {
        type: 'result',
        ok: false,
        text: 'key not allowed to access model',
        sessionId: 'ses_2',
        exitCode: 1,
      },
    ]);
  });
});

describe('agentRunners', () => {
  it('四種 kind 各配一個 runner', () => {
    const factory = agentRunners();
    expect(factory('claude')).toBeInstanceOf(ClaudeCodeRunner);
    expect(factory('codex')).toBeInstanceOf(CodexRunner);
    expect(factory('muse')).toBeInstanceOf(MuseRunner);
    expect(factory('opencode')).toBeInstanceOf(OpenCodeRunner);
  });

  it('把「CLI 設定」的環境變數也帶進無介面執行', () => {
    const secrets: CliSecrets = (id) => ({ env: { KEY_FOR: id } });
    agentRunners(secrets, spawner)('muse').start(task({ kind: 'muse' }));
    expect(spawner.last().spec.env).toEqual({ KEY_FOR: 'muse' });

    agentRunners(secrets, spawner)('claude').start(task());
    expect(spawner.last().spec.env).toEqual({ KEY_FOR: 'claude' });
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
