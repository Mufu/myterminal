import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRunPty } from '../src/main/agent-run-pty';
import { FakeAgentRun } from './fakes/fake-agent';

let run: FakeAgentRun;

beforeEach(() => {
  run = new FakeAgentRun();
});

/** 收下 AgentRunPty 寫出來的所有文字，並把 ANSI 色碼去掉方便斷言。*/
function attach(prompt = '只回覆 AGENT_SPIKE_OK'): { lines: () => string[]; exits: number[] } {
  const pty = new AgentRunPty(run, 'claude', prompt);
  const chunks: string[] = [];
  const exits: number[] = [];
  pty.onData((data) => chunks.push(data));
  pty.onExit(({ exitCode }) => exits.push(exitCode));
  return {
    lines: () =>
      chunks
        .join('')
        .replace(/\x1b\[\d+m/g, '')
        .split('\r\n')
        .slice(0, -1),
    exits,
  };
}

describe('AgentRunPty 把事件變成終端機看得懂的文字', () => {
  it('一開始就有一行任務標題 (onData 掛上之前產生的也不會掉)', () => {
    const out = attach('讀 README 然後\n說一句話');
    expect(out.lines()).toEqual(['[claude] 任務：讀 README 然後 說一句話']);
  });

  it('assistant 文字照原樣輸出，換行換成 CRLF', () => {
    const pty = new AgentRunPty(run, 'claude', 'x');
    const chunks: string[] = [];
    pty.onData((data) => chunks.push(data));

    run.emit({ type: 'text', text: '第一行\n第二行' });

    expect(chunks.at(-1)).toBe('第一行\r\n第二行\r\n');
  });

  it('tool 事件是一行 ⚙ 摘要，init 不出現在畫面上', () => {
    const out = attach();
    run.emit({ type: 'init', sessionId: 'abc' });
    run.emit({ type: 'tool', name: 'Read', summary: 'src/x.ts' });

    expect(out.lines().at(-1)).toBe('⚙ Read src/x.ts');
  });

  it('成功結束時印出頁尾並帶著 exit code 結束', () => {
    const out = attach();
    run.emit({ type: 'text', text: 'AGENT_SPIKE_OK' });
    run.emit({
      type: 'result',
      ok: true,
      text: 'AGENT_SPIKE_OK',
      sessionId: 'a7c9c5c6-ae75-4090-9d47-13fc2c0f23b7',
      durationMs: 12345,
      costUsd: 0.0041,
      exitCode: 0,
    });

    expect(out.lines().at(-1)).toBe('✔ 完成 · 12.3 s · $0.004 · session a7c9c5c6…');
    expect(out.exits).toEqual([0]);
  });

  it('失敗時印出原因與離開碼', () => {
    const out = attach();
    run.emit({ type: 'result', ok: false, text: '沒有這個模型', exitCode: 1 });

    expect(out.lines().at(-1)).toBe('✘ 失敗：沒有這個模型');
    expect(out.exits).toEqual([1]);
  });

  it('error 事件也算結束，離開碼是 1', () => {
    const out = attach();
    run.emit({ type: 'error', message: '已取消' });

    expect(out.lines().at(-1)).toBe('✘ 失敗 · 已取消');
    expect(out.exits).toEqual([1]);
  });
});

describe('AgentRunPty 的 pty 介面', () => {
  it('kill 會取消執行', () => {
    const pty = new AgentRunPty(run, 'codex', 'x');
    pty.kill();
    expect(run.cancelled).toBe(true);
  });

  it('write 與 resize 是 no-op (spike 沒有追問的介面)', () => {
    const pty = new AgentRunPty(run, 'codex', 'x');
    expect(() => {
      pty.write('dir\r');
      pty.resize(80, 24);
    }).not.toThrow();
  });
});
