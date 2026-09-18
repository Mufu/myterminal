import { describe, it, expect } from 'vitest';
import { edgePath, nodeSummary, promptHint, TYPE_LABELS } from '../src/renderer/workflow-editor-view';
import type { WorkflowNode, WorkflowNodeType } from '../src/shared/workflow';
import { DEFAULT_PARAMS } from '../src/shared/workflow';

/**
 * 畫布只有這幾個地方不必碰 DOM：連線的路徑、卡片上的摘要與提示欄位下面那一行。
 * 其餘的互動看 e2e/editor.spec.ts。
 */

describe('edgePath', () => {
  it('距離夠遠時兩端各水平拉出 60', () => {
    // dx = 200，一半是 100，被上限壓成 60
    expect(edgePath({ x: 100, y: 50 }, { x: 300, y: 150 })).toBe(
      'M 100 50 C 160 50, 240 150, 300 150',
    );
  });

  it('控制點跟著距離縮放，不會在近距離捲成一個圈', () => {
    // dx = 80 → 一半是 40
    expect(edgePath({ x: 0, y: 0 }, { x: 80, y: 0 })).toBe('M 0 0 C 40 0, 40 0, 80 0');
    // 內建範本相鄰兩個節點的水平距離只有 20，一半是 10，被下限撐成 16
    expect(edgePath({ x: 160, y: 15 }, { x: 180, y: 15 })).toBe(
      'M 160 15 C 176 15, 164 15, 180 15',
    );
  });

  it('往回接的線拉得更開，繞出一個看得出來的圈', () => {
    // dx = -340 → 40 + 85 = 125，被上限壓成 120
    expect(edgePath({ x: 700, y: 201 }, { x: 360, y: 15 })).toBe(
      'M 700 201 C 820 201, 240 15, 360 15',
    );
    // dx = -40 → 40 + 10
    expect(edgePath({ x: 100, y: 0 }, { x: 60, y: 40 })).toBe('M 100 0 C 150 0, 10 40, 60 40');
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
      nodeSummary(node({ type: 'agent', config: { kind: 'claude', prompt: 'x', permission: 'readonly' } })),
    ).toBe('');
  });
});

describe('TYPE_LABELS', () => {
  it('每一種節點型別都有中文名稱', () => {
    const types: WorkflowNodeType[] = ['start', 'end', 'agent', 'condition', 'approval'];
    for (const type of types) expect(TYPE_LABELS[type]).toBeTruthy();
  });
});

describe('promptHint', () => {
  it('列出這份工作流宣告的參數，最後補上節點的輸出', () => {
    expect(promptHint(DEFAULT_PARAMS)).toBe(
      '可用 {{params.task}}、{{params.cwd}}、{{<節點id>.text}}',
    );
    expect(promptHint([{ name: 'branch', label: '分支', kind: 'text', required: true }])).toBe(
      '可用 {{params.branch}}、{{<節點id>.text}}',
    );
    expect(promptHint([])).toBe('可用 {{<節點id>.text}}');
  });
});
