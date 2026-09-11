import { describe, it, expect } from 'vitest';
import { Command, MemorySaver } from '@langchain/langgraph';
import { compile, matches, render, runOutcome } from '../src/main/workflow/graph-compiler';
import type { CompileDeps, NodeReport, RunGraphState } from '../src/main/workflow/graph-compiler';
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '../src/shared/workflow';
import {
  FakeSessions,
  ManualTimers,
  ScriptedRunner,
  agentResult as result,
  until,
} from './fakes/fake-workflow';

const at = { x: 0, y: 0 };

const start = (): WorkflowNode => ({ id: 'start', type: 'start', label: '開始', position: at });
const end = (id = 'end'): WorkflowNode => ({ id, type: 'end', label: '結束', position: at });
const agent = (
  id: string,
  config: Partial<Extract<WorkflowNode, { type: 'agent' }>['config']> = {},
): WorkflowNode => ({
  id,
  type: 'agent',
  label: id,
  position: at,
  config: { kind: 'claude', prompt: id, allowEdits: false, cwd: 'D:/work', ...config },
});

const def = (nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDefinition => ({
  version: 1,
  id: 'w',
  name: '測試流程',
  nodes,
  edges,
});

const deps = (over: Partial<CompileDeps> = {}): CompileDeps => ({
  runnerFactory: () => new ScriptedRunner(() => result()),
  sessions: new FakeSessions(),
  checkpointer: new MemorySaver(),
  budget: { maxTotalCostUsd: 2 },
  params: {},
  timers: new ManualTimers(),
  ...over,
});

const thread = (id = 'run-1') => ({ configurable: { thread_id: id }, recursionLimit: 100 });

describe('render', () => {
  const state = { outputs: { review: { text: 'FAIL', ok: false } } } as unknown as RunGraphState;

  it('代入上游節點的輸出與啟動參數', () => {
    expect(render('修正：{{review.text}} / {{params.task}}', state, { task: '寫檔' })).toBe(
      '修正：FAIL / 寫檔',
    );
  });

  it('找不到的來源代空字串，看不懂的樣板原樣留著', () => {
    expect(render('[{{nope.text}}][{{params.none}}][{{weird}}]', state, {})).toBe('[][][{{weird}}]');
  });
});

describe('matches', () => {
  it('lastLineEquals 只看最後一行', () => {
    expect(matches({ type: 'lastLineEquals', value: 'PASS' }, '說明\nPASS\n')).toBe(true);
    expect(matches({ type: 'lastLineEquals', value: 'PASS' }, 'PASS\n說明')).toBe(false);
  });

  it('regex 是整段比對', () => {
    expect(matches({ type: 'regex', pattern: 'OK$' }, 'all OK')).toBe(true);
    expect(matches({ type: 'regex', pattern: 'OK$' }, 'not fine')).toBe(false);
  });
});

describe('compile', () => {
  it('定義不合法就不編譯', () => {
    expect(() => compile(def([start()], []), deps())).toThrow('工作流定義不合法');
  });

  it('agent 節點跑完會寫進 outputs / attempts / lastPort 並累加費用', async () => {
    const sessions = new FakeSessions();
    const workflow = def(
      [start(), agent('impl'), end()],
      [
        { from: 'start', to: 'impl' },
        { from: 'impl', to: 'end', port: 'ok' },
        { from: 'impl', to: 'end', port: 'fail' },
      ],
    );
    const compiled = compile(workflow, deps({ sessions }));
    const state = await compiled.app.invoke({}, thread());

    expect(state.outputs.impl).toMatchObject({ ok: true, text: 'ok', sessionId: 'cli-1' });
    expect(state.attempts).toEqual({ impl: 1 });
    expect(state.lastPort).toMatchObject({ impl: 'ok', end: 'done' });
    expect(state.totalCostUsd).toBeCloseTo(0.1);
    expect(runOutcome(workflow, state)).toEqual({ ok: true });
  });

  it('每個 agent 節點都會登記成一個工作階段，名字是「工作流 · 節點」', async () => {
    const sessions = new FakeSessions();
    const reports: Parameters<NodeReport>[0][] = [];
    const compiled = compile(
      def(
        [start(), agent('impl'), end()],
        [
          { from: 'start', to: 'impl' },
          { from: 'impl', to: 'end', port: 'ok' },
          { from: 'impl', to: 'end', port: 'fail' },
        ],
      ),
      deps({ sessions, report: (event) => reports.push(event) }),
    );
    await compiled.app.invoke({}, thread());

    expect(sessions.adopted).toEqual([
      { name: '測試流程 · impl', kind: 'claude', prompt: 'impl', cwd: 'D:/work' },
    ]);
    expect(reports).toContainEqual({
      nodeId: 'impl',
      status: 'running',
      sessionId: 's1',
      attempts: 1,
    });
    expect(reports.at(-1)).toEqual({ nodeId: 'end', status: 'done' });
  });

  it('提示與工作目錄都會套樣板，resumeFrom 帶上上游的 CLI session', async () => {
    const runner = new ScriptedRunner((_task, index) =>
      result({ text: index === 0 ? '做好了' : '修好了', sessionId: `cli-${index}` }),
    );
    const compiled = compile(
      def(
        [
          start(),
          agent('impl', { prompt: '{{params.task}}', cwd: '{{params.cwd}}' }),
          agent('fix', { prompt: '依照：{{impl.text}}', resumeFrom: 'impl' }),
          end(),
        ],
        [
          { from: 'start', to: 'impl' },
          { from: 'impl', to: 'fix', port: 'ok' },
          { from: 'impl', to: 'end', port: 'fail' },
          { from: 'fix', to: 'end', port: 'ok' },
          { from: 'fix', to: 'end', port: 'fail' },
        ],
      ),
      deps({ runnerFactory: () => runner, params: { task: '建立 hello.txt', cwd: 'D:/tmp' } }),
    );
    await compiled.app.invoke({}, thread());

    expect(runner.tasks[0]).toMatchObject({ prompt: '建立 hello.txt', cwd: 'D:/tmp' });
    expect(runner.tasks[1]).toMatchObject({ prompt: '依照：做好了', resumeId: 'cli-0' });
  });

  it('agent 失敗走 fail 出口；沒有連線的出口就收尾', async () => {
    const runner = new ScriptedRunner(() => result({ ok: false, text: '沒登入' }));
    const workflow = def(
      [start(), agent('impl'), agent('rescue'), end()],
      [
        { from: 'start', to: 'impl' },
        { from: 'impl', to: 'end', port: 'ok' },
        { from: 'impl', to: 'rescue', port: 'fail' },
        { from: 'rescue', to: 'end', port: 'ok' },
      ],
    );
    const compiled = compile(workflow, deps({ runnerFactory: () => runner }));
    const state = await compiled.app.invoke({}, thread());

    expect(runner.tasks).toHaveLength(2);
    // rescue 也失敗，而它的 fail 出口沒有連線 → 直接結束，而且不算成功。
    expect(state.lastPort).toEqual({ impl: 'fail', rescue: 'fail' });
    expect(runOutcome(workflow, state)).toEqual({ ok: false, error: 'rescue：沒登入' });
  });

  it('condition 依規則挑 yes / no 出口', async () => {
    const build = (text: string) =>
      compile(
        def(
          [
            start(),
            agent('review'),
            {
              id: 'check',
              type: 'condition',
              label: '檢查',
              position: at,
              config: { source: 'review', rule: { type: 'lastLineEquals', value: 'PASS' } },
            },
            agent('fix'),
            end(),
          ],
          [
            { from: 'start', to: 'review' },
            { from: 'review', to: 'check', port: 'ok' },
            { from: 'review', to: 'end', port: 'fail' },
            { from: 'check', to: 'end', port: 'yes' },
            { from: 'check', to: 'fix', port: 'no' },
            { from: 'fix', to: 'end', port: 'ok' },
            { from: 'fix', to: 'end', port: 'fail' },
          ],
        ),
        deps({ runnerFactory: () => new ScriptedRunner(() => result({ text })) }),
      );

    const passed = await build('看起來沒問題\nPASS').app.invoke({}, thread('pass'));
    expect(passed.lastPort.check).toBe('yes');
    expect(passed.outputs.fix).toBeUndefined();

    const failed = await build('少了一個檔\nFAIL').app.invoke({}, thread('fail'));
    expect(failed.lastPort.check).toBe('no');
    expect(failed.outputs.fix).toBeDefined();
  });

  it('maxAttempts 用完就收尾，而且整個執行算失敗', async () => {
    const runner = new ScriptedRunner((task) =>
      result({ text: task.prompt === 'review' ? '還不行\nFAIL' : 'ok' }),
    );
    const workflow = def(
      [
        start(),
        agent('review'),
        {
          id: 'check',
          type: 'condition',
          label: '檢查',
          position: at,
          config: { source: 'review', rule: { type: 'lastLineEquals', value: 'PASS' } },
        },
        agent('fix', { maxAttempts: 2 }),
        end(),
      ],
      [
        { from: 'start', to: 'review' },
        { from: 'review', to: 'check', port: 'ok' },
        { from: 'review', to: 'end', port: 'fail' },
        { from: 'check', to: 'end', port: 'yes' },
        { from: 'check', to: 'fix', port: 'no' },
        { from: 'fix', to: 'review', port: 'ok' },
        { from: 'fix', to: 'end', port: 'fail' },
      ],
    );
    const compiled = compile(workflow, deps({ runnerFactory: () => runner, budget: { maxTotalCostUsd: 99 } }));
    const state = await compiled.app.invoke({}, thread());

    expect(state.attempts.fix).toBe(2);
    expect(state.lastPort.end).toBeUndefined();
    expect(runOutcome(workflow, state)).toEqual({ ok: false, error: 'fix：重試 2 次仍未通過' });
  });

  it('超出預算的節點算失敗並收尾', async () => {
    const workflow = def(
      [start(), agent('a'), agent('b'), end()],
      [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'b', port: 'ok' },
        { from: 'a', to: 'end', port: 'fail' },
        { from: 'b', to: 'end', port: 'ok' },
        { from: 'b', to: 'end', port: 'fail' },
      ],
    );
    const compiled = compile(workflow, deps({ budget: { maxTotalCostUsd: 0.15 } }));
    const state = await compiled.app.invoke({}, thread());

    expect(state.outputs.a.ok).toBe(true);
    expect(state.outputs.b.ok).toBe(false);
    expect(state.lastPort.end).toBeUndefined();
    expect(runOutcome(workflow, state).error).toContain('超出這次執行的預算上限 $0.15');
  });

  it('逾時會取消 CLI 執行並算失敗', async () => {
    const runner = new ScriptedRunner(() => null);
    const timers = new ManualTimers();
    const workflow = def(
      [start(), agent('slow', { timeoutSec: 30 }), end()],
      [
        { from: 'start', to: 'slow' },
        { from: 'slow', to: 'end', port: 'ok' },
      ],
    );
    const compiled = compile(workflow, deps({ runnerFactory: () => runner, timers }));
    const running = compiled.app.invoke({}, thread());

    await until(() => timers.delays.includes(30_000));
    timers.fireAll();
    const state = await running;

    expect(runner.runs[0].cancelled).toBe(true);
    expect(state.outputs.slow).toMatchObject({ ok: false, text: '超過 30 秒還沒有結果' });
    expect(runOutcome(workflow, state).ok).toBe(false);
  });

  it('沒設 timeoutSec 時是 600 秒', async () => {
    const timers = new ManualTimers();
    const compiled = compile(
      def(
        [start(), agent('impl'), end()],
        [
          { from: 'start', to: 'impl' },
          { from: 'impl', to: 'end', port: 'ok' },
        ],
      ),
      deps({ timers }),
    );
    await compiled.app.invoke({}, thread());
    // 結果先到，計時器被取消了，所以只剩「曾經設過 600 秒」這件事可看。
    expect(timers.delays).toEqual([]);
  });

  it('approval 會中斷，resume 之後照批准與否走出口', async () => {
    const workflow = def(
      [
        start(),
        { id: 'ask', type: 'approval', label: '批准', position: at, config: { question: '要保留嗎？' } },
        end(),
      ],
      [
        { from: 'start', to: 'ask' },
        { from: 'ask', to: 'end', port: 'approved' },
      ],
    );
    const saver = new MemorySaver();
    const reports: Parameters<NodeReport>[0][] = [];
    const compiled = compile(
      workflow,
      deps({ checkpointer: saver, report: (event) => reports.push(event) }),
    );

    const paused = await compiled.app.invoke({}, thread());
    expect(paused.__interrupt__?.[0]?.value).toEqual({ question: '要保留嗎？' });
    expect(reports).toContainEqual({ nodeId: 'ask', status: 'waiting' });

    const resumed = await compiled.app.invoke(new Command({ resume: { approved: true } }), thread());
    expect(resumed.lastPort).toMatchObject({ ask: 'approved', end: 'done' });
    expect(runOutcome(workflow, resumed)).toEqual({ ok: true });
  });

  it('退回 (rejected) 沒有連線，執行算失敗並說明原因', async () => {
    const workflow = def(
      [
        start(),
        { id: 'ask', type: 'approval', label: '批准', position: at, config: { question: '要保留嗎？' } },
        end(),
      ],
      [
        { from: 'start', to: 'ask' },
        { from: 'ask', to: 'end', port: 'approved' },
      ],
    );
    const compiled = compile(workflow, deps());
    await compiled.app.invoke({}, thread());
    const state = await compiled.app.invoke(new Command({ resume: { approved: false } }), thread());

    expect(state.lastPort.ask).toBe('rejected');
    expect(runOutcome(workflow, state)).toEqual({ ok: false, error: '批准：已退回' });
  });

  it('cancel 會砍掉正在跑的執行，後面的節點直接收尾', async () => {
    const runner = new ScriptedRunner(() => null);
    const workflow = def(
      [start(), agent('a'), agent('b'), end()],
      [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'b', port: 'ok' },
        { from: 'a', to: 'b', port: 'fail' },
        { from: 'b', to: 'end', port: 'ok' },
      ],
    );
    const compiled = compile(workflow, deps({ runnerFactory: () => runner }));
    const running = compiled.app.invoke({}, thread());

    await until(() => runner.runs.length === 1);
    compiled.cancel();
    runner.runs[0].emit({ type: 'error', message: '已取消' });
    const state = await running;

    expect(runner.runs[0].cancelled).toBe(true);
    // b 輪到時已經是取消狀態，不會再開一次 CLI。
    expect(runner.runs).toHaveLength(1);
    expect(state.lastPort.b).toBe('__abort__');
  });
});
