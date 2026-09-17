import { describe, it, expect } from 'vitest';
import { cardOverlay, latestRunFor, nodeStatusLabel } from '../src/renderer/workflow-run-view';
import type { RunNodeState, RunNodeStatus, RunState } from '../src/shared/workflow';
import type { CliAuthStatus } from '../src/shared/cli-auth';

/**
 * 畫布上的「執行檢視」只有這兩個地方不必碰 DOM：挑哪一次執行、
 * 一張卡片上要寫什麼。其餘的看 e2e/editor-run.spec.ts。
 */

const node = (over: Partial<RunNodeState> = {}): RunNodeState => ({
  label: '節點',
  status: 'idle',
  attempts: 0,
  ...over,
});

const run = (over: Partial<RunState> = {}): RunState => ({
  runId: 'run-1',
  workflowId: 'wf-1',
  name: '我的流程',
  status: 'running',
  params: {},
  nodes: {},
  totalCostUsd: 0,
  startedAt: 1000,
  ...over,
});

describe('latestRunFor', () => {
  it('沒有這份工作流的執行就是 null', () => {
    expect(latestRunFor([], 'wf-1')).toBeNull();
    expect(latestRunFor([run({ workflowId: 'wf-2' })], 'wf-1')).toBeNull();
  });

  it('沒有還在跑的就挑最近開始的那一次', () => {
    const old = run({ runId: 'a', status: 'done', startedAt: 100 });
    const recent = run({ runId: 'b', status: 'failed', startedAt: 300 });
    expect(latestRunFor([recent, old], 'wf-1')?.runId).toBe('b');
  });

  it('還在跑的優先，即使它比較早開始', () => {
    const live = run({ runId: 'a', status: 'running', startedAt: 100 });
    const done = run({ runId: 'b', status: 'done', startedAt: 300 });
    expect(latestRunFor([live, done], 'wf-1')?.runId).toBe('a');
  });

  it('等待批准也算還在跑', () => {
    const waiting = run({ runId: 'a', status: 'waiting_approval', startedAt: 100 });
    const done = run({ runId: 'b', status: 'done', startedAt: 300 });
    expect(latestRunFor([waiting, done], 'wf-1')?.runId).toBe('a');
  });

  it('兩次都還在跑時挑晚開始的那一次', () => {
    const first = run({ runId: 'a', status: 'running', startedAt: 100 });
    const second = run({ runId: 'b', status: 'waiting_approval', startedAt: 200 });
    expect(latestRunFor([first, second], 'wf-1')?.runId).toBe('b');
  });
});

describe('nodeStatusLabel', () => {
  it('每個節點狀態都有中文名稱', () => {
    const labels: Record<RunNodeStatus, string> = {
      idle: '等待',
      running: '執行中',
      done: '完成',
      failed: '失敗',
      waiting: '等待批准',
      skipped: '略過',
      cancelled: '已取消',
    };
    for (const [status, label] of Object.entries(labels)) {
      expect(nodeStatusLabel(status as RunNodeStatus)).toBe(label);
    }
  });
});

describe('cardOverlay', () => {
  const auth: CliAuthStatus = {
    claude: { loggedIn: true, mode: 'subscription', label: 'Max 訂閱' },
    codex: { loggedIn: true, mode: 'api', label: 'API 金鑰' },
    muse: { loggedIn: true, mode: 'subscription', label: 'Meta 帳號' },
    opencode: { loggedIn: true, mode: 'api', label: 'API 金鑰' },
  };

  it('沒有執行、或這次執行沒有這個節點，就沒有覆蓋層', () => {
    expect(cardOverlay(null, 'agent-1')).toBeNull();
    expect(cardOverlay(run(), 'agent-1')).toBeNull();
  });

  it('狀態與中文名稱照 RunNodeState 走', () => {
    const state = run({ nodes: { 'agent-1': node({ status: 'running' }) } });
    expect(cardOverlay(state, 'agent-1')).toEqual({
      status: 'running',
      label: '執行中',
      waitingApproval: false,
    });
  });

  it('金額照那一支 CLI 的登入方式寫；訂閱是估算', () => {
    const state = run({
      nodes: {
        'agent-1': node({ status: 'done', kind: 'claude', costUsd: 0.09 }),
        'agent-2': node({ status: 'done', kind: 'codex', costUsd: 0.09 }),
      },
    });
    expect(cardOverlay(state, 'agent-1', auth)?.usage).toBe('≈$0.090');
    expect(cardOverlay(state, 'agent-2', auth)?.usage).toBe('$0.090');
    // 還沒探測回來就一律當成估算。
    expect(cardOverlay(state, 'agent-1')?.usage).toBe('≈$0.090');
  });

  it('有工作階段才給得出「輸出」按鈕', () => {
    const state = run({ nodes: { 'agent-1': node({ status: 'done', sessionId: 's-1' }) } });
    expect(cardOverlay(state, 'agent-1')?.sessionId).toBe('s-1');
  });

  it('整次執行停在這個批准節點時才是 waitingApproval', () => {
    const nodes = { 'approval-1': node({ status: 'waiting' }) };
    expect(cardOverlay(run({ status: 'waiting_approval', nodes }), 'approval-1')).toMatchObject({
      label: '等待批准',
      waitingApproval: true,
    });
    // 執行已經被取消，那個節點的狀態還留著，但已經沒有人可以批准了。
    expect(cardOverlay(run({ status: 'cancelled', nodes }), 'approval-1')?.waitingApproval).toBe(
      false,
    );
  });
});
