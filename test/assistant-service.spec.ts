import { describe, it, expect, beforeEach } from 'vitest';
import { AssistantService } from '../src/main/assistant-service';
import { FakeProcessSpawner } from './fakes/fake-process';
import type { AssistantEvent } from '../src/shared/assistant';

let spawner: FakeProcessSpawner;
let loggedIn: boolean;

beforeEach(() => {
  spawner = new FakeProcessSpawner();
  loggedIn = true;
});

const service = (): AssistantService =>
  new AssistantService(spawner, {
    knowledgePath: 'C:/kb/ASSISTANT.md',
    isClaudeLoggedIn: () => loggedIn,
  });

/** stream-json 的三行：init、一段回答、result。*/
const line = {
  init: (sessionId: string) =>
    `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId })}\n`,
  text: (text: string) =>
    `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`,
  result: (sessionId: string, over: Record<string, unknown> = {}) =>
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: sessionId,
      result: '',
      duration_ms: 4200,
      total_cost_usd: 0.012,
      ...over,
    })}\n`,
};

/**
 * 問一次並把整段 stdout 餵進去。回傳收到的事件 ——
 * ask() 要等行程結束才會 resolve，所以事件都收齊了才回來。
 */
async function ask(
  s: AssistantService,
  stdout: string,
  question = '怎麼開 WSL 工作階段？',
  context = '[目前狀態] 終端機',
  exitCode = 0,
): Promise<AssistantEvent[]> {
  const events: AssistantEvent[] = [];
  const done = s.ask(question, context, (event) => events.push(event));
  spawner.last().emitStdout(stdout);
  spawner.last().emitExit(exitCode);
  await done;
  return events;
}

describe('AssistantService 組出來的命令列', () => {
  it('Sonnet、關掉工具、知識檔走 --append-system-prompt-file，問題走 stdin', () => {
    void service().ask('怎麼開 WSL 工作階段？', '[目前狀態] 終端機', () => {});
    const spec = spawner.last().spec;

    expect(spec.file).toBe('claude');
    expect(spec.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'sonnet',
      '--tools',
      '',
      '--append-system-prompt-file',
      'C:/kb/ASSISTANT.md',
    ]);
    expect(spec.stdin).toBe('[目前狀態] 終端機\n\n怎麼開 WSL 工作階段？');
  });

  it('model 可以換掉', () => {
    const s = new AssistantService(spawner, {
      knowledgePath: 'C:/kb/ASSISTANT.md',
      isClaudeLoggedIn: () => true,
      model: 'haiku',
    });
    void s.ask('問題', '狀態', () => {});
    expect(spawner.last().spec.args.slice(4, 6)).toEqual(['--model', 'haiku']);
  });

  it('第二次問接續同一段對話 (--resume)，reset() 之後又是新的', async () => {
    const s = service();
    await ask(s, line.init('sess-1') + line.text('第一次') + line.result('sess-1'));
    expect(spawner.last().spec.args).not.toContain('--resume');

    await ask(s, line.text('第二次') + line.result('sess-1'));
    expect(spawner.last().spec.args.slice(-2)).toEqual(['--resume', 'sess-1']);

    s.reset();
    void s.ask('第三次', '狀態', () => {});
    expect(spawner.last().spec.args).not.toContain('--resume');
  });
});

describe('AssistantService 的事件', () => {
  it('回答文字變成 delta，結束時給 done 與金額、耗時、session', async () => {
    const events = await ask(
      service(),
      line.init('sess-1') + line.text('按「新連接」，') + line.text('類型選「WSL」。') +
        line.result('sess-1'),
    );

    expect(events).toEqual([
      { type: 'delta', text: '按「新連接」，' },
      { type: 'delta', text: '類型選「WSL」。' },
      { type: 'done', sessionId: 'sess-1', costUsd: 0.012, durationMs: 4200 },
    ]);
  });

  it('只有 result 帶著文字時，那段文字也要顯示出來', async () => {
    const events = await ask(
      service(),
      line.init('sess-1') + line.result('sess-1', { result: '只在 result 裡的答案' }),
    );

    expect(events[0]).toEqual({ type: 'delta', text: '只在 result 裡的答案' });
  });

  it('CLI 回報失敗就是 error，不是 done', async () => {
    const events = await ask(
      service(),
      line.init('sess-1') + line.result('sess-1', { is_error: true, result: '額度用完了' }),
    );

    expect(events).toEqual([{ type: 'error', message: '額度用完了' }]);
  });

  it('CLI 沒有回報結果時，錯誤訊息是 stderr 的最後一行', async () => {
    const s = service();
    const events: AssistantEvent[] = [];
    const done = s.ask('問題', '狀態', (event) => events.push(event));
    spawner.last().emitStderr('spawn claude ENOENT\n');
    spawner.last().emitExit(1);
    await done;

    expect(events).toEqual([{ type: 'error', message: 'spawn claude ENOENT' }]);
  });
});

describe('AssistantService 的守門', () => {
  it('上一個問題還在回答中就不受理第二個', async () => {
    const s = service();
    const first = s.ask('第一個', '狀態', () => {});

    await expect(s.ask('第二個', '狀態', () => {})).rejects.toThrow('上一個問題還在回答中');
    expect(spawner.spawned).toHaveLength(1);

    spawner.last().emitStdout(line.init('sess-1') + line.result('sess-1'));
    spawner.last().emitExit(0);
    await first;
    // 上一個結束了就受理得了下一個。
    void s.ask('第二個', '狀態', () => {});
    expect(spawner.spawned).toHaveLength(2);
  });

  it('Claude 沒登入時直接擋下來，不開行程', async () => {
    loggedIn = false;
    await expect(service().ask('問題', '狀態', () => {})).rejects.toThrow(
      'Claude 尚未登入，請先在「CLI 設定」登入',
    );
    expect(spawner.spawned).toHaveLength(0);
  });

  it('cancel() 砍掉行程，事件是「已取消」', async () => {
    const s = service();
    const events: AssistantEvent[] = [];
    const done = s.ask('問題', '狀態', (event) => events.push(event));

    s.cancel();
    expect(spawner.last().killed).toBe(true);
    spawner.last().emitExit(1);
    await done;

    expect(events).toEqual([{ type: 'error', message: '已取消' }]);
    // 取消完就不是「還在回答中」了。
    void s.ask('下一個', '狀態', () => {});
    expect(spawner.spawned).toHaveLength(2);
  });

  it('沒有在回答時 cancel() 什麼都不做', () => {
    expect(() => service().cancel()).not.toThrow();
    expect(spawner.spawned).toHaveLength(0);
  });
});
