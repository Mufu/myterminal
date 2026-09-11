import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '../src/shared/workflow';
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '../src/shared/workflow';

const at = { x: 0, y: 0 };

const start = (id = 'start'): WorkflowNode => ({ id, type: 'start', label: '開始', position: at });
const end = (id = 'end'): WorkflowNode => ({ id, type: 'end', label: '結束', position: at });
const agent = (id: string): WorkflowNode => ({
  id,
  type: 'agent',
  label: id,
  position: at,
  config: { kind: 'claude', prompt: 'x', allowEdits: false },
});
const approval = (id: string): WorkflowNode => ({
  id,
  type: 'approval',
  label: id,
  position: at,
  config: { question: '要嗎？' },
});

const def = (nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDefinition => ({
  version: 1,
  id: 'w',
  name: '測試',
  nodes,
  edges,
});

/** 最小的合法工作流：開始 → agent → 結束。*/
const minimal = (): WorkflowDefinition =>
  def(
    [start(), agent('a'), end()],
    [
      { from: 'start', to: 'a' },
      { from: 'a', to: 'end', port: 'ok' },
      { from: 'a', to: 'end', port: 'fail' },
    ],
  );

describe('validateWorkflow', () => {
  it('合法的定義沒有錯誤', () => {
    expect(validateWorkflow(minimal())).toEqual([]);
  });

  it('開始節點必須剛好一個', () => {
    const none = def([agent('a'), end()], []);
    expect(validateWorkflow(none).join()).toContain('剛好有一個開始節點');

    const two = minimal();
    two.nodes.push(start('start2'));
    expect(validateWorkflow(two).join()).toContain('剛好有一個開始節點');
  });

  it('至少要有一個結束節點', () => {
    const d = def([start(), agent('a')], [{ from: 'start', to: 'a' }]);
    expect(validateWorkflow(d).join()).toContain('至少有一個結束節點');
  });

  it('連線的兩端都必須存在', () => {
    const d = minimal();
    d.edges.push({ from: 'nope', to: 'end', port: 'ok' });
    d.edges.push({ from: 'start', to: 'nowhere' });
    const errors = validateWorkflow(d).join('\n');
    expect(errors).toContain('起點節點不存在：nope');
    expect(errors).toContain('終點節點不存在：nowhere');
  });

  it('有出口的節點一定要指定出口，而且要是自己的出口', () => {
    const missing = def(
      [start(), agent('a'), end()],
      [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'end' },
      ],
    );
    expect(validateWorkflow(missing).join()).toContain('a 的出口必須是 ok 或 fail');

    const wrong = def(
      [start(), approval('p'), end()],
      [
        { from: 'start', to: 'p' },
        { from: 'p', to: 'end', port: 'ok' },
      ],
    );
    expect(validateWorkflow(wrong).join()).toContain('p 的出口必須是 approved 或 rejected');
  });

  it('start 的連線不能指定出口', () => {
    const d = minimal();
    d.edges[0] = { from: 'start', to: 'a', port: 'ok' };
    expect(validateWorkflow(d).join()).toContain('連線不能指定出口');
  });

  it('同一個出口只能有一條連線', () => {
    const d = minimal();
    d.edges.push({ from: 'a', to: 'end', port: 'ok' });
    expect(validateWorkflow(d).join()).toContain('出口 ok 重複連線');

    const twice = minimal();
    twice.edges.push({ from: 'start', to: 'a' });
    expect(validateWorkflow(twice).join()).toContain('出口 (單一) 重複連線');
  });

  it('從開始節點走不到的節點是錯的', () => {
    const d = minimal();
    d.nodes.push(agent('orphan'));
    expect(validateWorkflow(d).join()).toContain('節點 orphan 從開始節點走不到');
  });

  it('回頭的連線不會被當成走不到 (BFS 不會無限繞)', () => {
    const d = def(
      [start(), agent('a'), agent('b'), end()],
      [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'b', port: 'ok' },
        { from: 'a', to: 'end', port: 'fail' },
        { from: 'b', to: 'a', port: 'fail' },
        { from: 'b', to: 'end', port: 'ok' },
      ],
    );
    expect(validateWorkflow(d)).toEqual([]);
  });
});
