import { describe, it, expect } from 'vitest';
import { edgePath, nodeSummary, TYPE_LABELS } from '../src/renderer/workflow-editor-view';
import type { WorkflowNode, WorkflowNodeType } from '../src/shared/workflow';

/**
 * 畫布只有這兩個地方不必碰 DOM：連線的路徑與卡片上的摘要。
 * 其餘的互動看 e2e/editor.spec.ts。
 */

describe('edgePath', () => {
  it('兩端各水平拉出 60 的立方貝茲', () => {
    expect(edgePath({ x: 100, y: 50 }, { x: 300, y: 150 })).toBe(
      'M 100 50 C 160 50, 240 150, 300 150',
    );
  });
});

describe('nodeSummary', () => {
  const node = (over: Partial<WorkflowNode>): WorkflowNode =>
    ({ id: 'n', label: 'n', position: { x: 0, y: 0 }, ...over }) as WorkflowNode;

  it('條件節點是規則摘要', () => {
    expect(
      nodeSummary(
        node({ type: 'condition', config: { source: 'review', rule: { type: 'lastLineEquals', value: 'PASS' } } }),
      ),
    ).toBe('review 最後一行 = PASS');

    expect(
      nodeSummary(node({ type: 'condition', config: { source: '', rule: { type: 'regex', pattern: 'ok' } } })),
    ).toBe('？ 符合 /ok/');
  });

  it('批准節點是問題的前 30 個字', () => {
    const question = '一'.repeat(40);
    expect(nodeSummary(node({ type: 'approval', config: { question } }))).toBe('一'.repeat(30));
  });

  it('開始／結束／agent 沒有摘要 (agent 貼的是角色標籤)', () => {
    expect(nodeSummary(node({ type: 'start' }))).toBe('');
    expect(nodeSummary(node({ type: 'end' }))).toBe('');
    expect(
      nodeSummary(node({ type: 'agent', config: { kind: 'claude', prompt: 'x', allowEdits: false } })),
    ).toBe('');
  });
});

describe('TYPE_LABELS', () => {
  it('每一種節點型別都有中文名稱', () => {
    const types: WorkflowNodeType[] = ['start', 'end', 'agent', 'condition', 'approval'];
    for (const type of types) expect(TYPE_LABELS[type]).toBeTruthy();
  });
});
