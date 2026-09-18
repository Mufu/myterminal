import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkflowEditorModel,
  NODE_WIDTH,
  NODE_HEADER,
  PORT_ROW,
  GRID,
  PORT_LABELS,
  newWorkflowId,
  snap,
} from '../src/renderer/workflow-editor-model';
import { DEFAULT_PARAMS, NODE_PORTS } from '../src/shared/workflow';
import type { WorkflowDefinition, WorkflowPort } from '../src/shared/workflow';

let model: WorkflowEditorModel;

beforeEach(() => {
  model = new WorkflowEditorModel();
  model.newWorkflow();
});

/** 一份有 agent 的定義，載入用。*/
const saved = (): WorkflowDefinition => ({
  version: 1,
  id: 'wf-saved',
  name: '存過的',
  nodes: [
    { id: 'start', type: 'start', label: '開始', position: { x: 0, y: 0 } },
    {
      id: 'work',
      type: 'agent',
      label: '實作',
      position: { x: 200, y: 0 },
      config: { kind: 'claude', prompt: '{{params.task}}', cwd: '{{params.cwd}}', permission: 'edit' },
    },
    { id: 'end', type: 'end', label: '結束', position: { x: 400, y: 0 } },
  ],
  edges: [
    { from: 'start', to: 'work' },
    { from: 'work', to: 'end', port: 'ok' },
  ],
});

describe('新工作流', () => {
  it('只有開始與結束兩個節點，沒有連線', () => {
    const { nodes, edges, name, version } = model.definition;
    expect(version).toBe(1);
    expect(name).toBe('新工作流');
    expect(nodes.map((n) => [n.id, n.type, n.position])).toEqual([
      ['start', 'start', { x: 40, y: 120 }],
      ['end', 'end', { x: 600, y: 120 }],
    ]);
    expect(edges).toEqual([]);
  });

  it('id 是 wf- 開頭，而且每次都不一樣', () => {
    const first = model.definition.id;
    expect(first).toMatch(/^wf-/);
    model.newWorkflow();
    expect(model.definition.id).not.toBe(first);
    expect(newWorkflowId()).toMatch(/^wf-/);
  });

  it('來源是 new，沒有選取，也不是髒的', () => {
    expect(model.source).toBe('new');
    expect(model.selection).toBeNull();
    expect(model.dirty).toBe(false);
  });
});

describe('載入既有定義', () => {
  it('深拷貝：改畫布上的節點不會動到原本那份', () => {
    const original = saved();
    model.load(original, 'custom');
    model.updateNode('work', { label: '改過' });
    expect(original.nodes[1].label).toBe('實作');
    expect(model.definition.name).toBe('存過的');
  });

  it('記住來源，並且是乾淨的', () => {
    model.load(saved(), 'builtin');
    expect(model.source).toBe('builtin');
    expect(model.dirty).toBe(false);
  });

  it('markSaved 之後是乾淨的自訂工作流', () => {
    model.load(saved(), 'builtin');
    model.setName('改名');
    expect(model.dirty).toBe(true);
    model.markSaved();
    expect(model.dirty).toBe(false);
    expect(model.source).toBe('custom');
  });
});

describe('訂閱與 dirty', () => {
  it('每一次修改都通知訂閱者 (Observer)', () => {
    let notified = 0;
    model.subscribe(() => (notified += 1));
    model.addNode('agent');
    model.setName('x');
    expect(notified).toBe(2);
  });

  it('unsubscribe 之後不再收到通知', () => {
    let notified = 0;
    const off = model.subscribe(() => (notified += 1));
    off();
    model.addNode('agent');
    expect(notified).toBe(0);
  });

  it('任何修改都會變髒，newWorkflow / load 之後變乾淨', () => {
    model.addNode('agent');
    expect(model.dirty).toBe(true);
    model.newWorkflow();
    expect(model.dirty).toBe(false);
    model.setName('x');
    model.load(saved(), 'custom');
    expect(model.dirty).toBe(false);
  });

  it('選取只通知，不算修改', () => {
    let notified = 0;
    model.subscribe(() => (notified += 1));
    model.select({ kind: 'node', id: 'start' });
    expect(notified).toBe(1);
    expect(model.dirty).toBe(false);
    expect(model.selection).toEqual({ kind: 'node', id: 'start' });
  });

  it('選同一個不重複通知', () => {
    model.select({ kind: 'node', id: 'start' });
    let notified = 0;
    model.subscribe(() => (notified += 1));
    model.select({ kind: 'node', id: 'start' });
    expect(notified).toBe(0);
  });
});

describe('加節點', () => {
  it('id 是型別加序號，從 1 開始找沒被用掉的', () => {
    expect(model.addNode('agent')).toBe('agent-1');
    expect(model.addNode('agent')).toBe('agent-2');
    expect(model.addNode('condition')).toBe('condition-1');
    expect(model.addNode('approval')).toBe('approval-1');
    // 新工作流已經有一個叫 end 的節點，再加一個是 end-1
    expect(model.addNode('end')).toBe('end-1');
  });

  it('刪掉中間那個之後，序號補回來', () => {
    model.addNode('agent');
    model.addNode('agent');
    model.removeNode('agent-1');
    expect(model.addNode('agent')).toBe('agent-1');
  });

  it('各型別的預設名稱與設定', () => {
    model.addNode('agent');
    model.addNode('condition');
    model.addNode('approval');
    const agent = model.node('agent-1');
    const condition = model.node('condition-1');
    const approval = model.node('approval-1');

    expect(agent).toMatchObject({
      label: 'Agent',
      config: { kind: 'claude', prompt: '', cwd: '{{params.cwd}}', permission: 'readonly' },
    });
    expect(condition).toMatchObject({
      label: '條件',
      config: { source: '', rule: { type: 'lastLineEquals', value: '' } },
    });
    expect(approval).toMatchObject({ label: '批准', config: { question: '' } });
  });

  it('沒指定位置就放在最右邊那個節點的右側', () => {
    model.addNode('agent');
    // 最右邊是 end (600, 120)
    expect(model.node('agent-1')?.position).toEqual({ x: 600 + NODE_WIDTH + 40, y: 120 });
  });

  /** 一直往右排的話第三個就跑到畫面外了。*/
  it('排到最右邊就換下一行', () => {
    // end 在 (600, 120)，加一個到 800，再加一個就要 1000 以上了。
    model.addNode('agent');
    expect(model.node('agent-1')?.position).toEqual({ x: 800, y: 120 });
    model.addNode('agent');
    expect(model.node('agent-2')?.position).toEqual({ x: 1000, y: 120 });
    model.addNode('agent');
    expect(model.node('agent-3')?.position).toEqual({ x: 40, y: 280 });
  });

  it('指定的位置會吸附到格線上', () => {
    model.addNode('agent', { x: 123, y: 456 });
    expect(model.node('agent-1')?.position).toEqual({ x: 120, y: 460 });
  });
});

describe('移動節點', () => {
  it('吸附到格線上', () => {
    model.moveNode('start', { x: 47, y: 122 });
    expect(model.node('start')?.position).toEqual({ x: 50, y: 120 });
    expect(snap({ x: 4, y: 5 })).toEqual({ x: 0, y: GRID });
  });

  it('不存在的節點不會炸也不會變髒', () => {
    model.moveNode('nope', { x: 0, y: 0 });
    expect(model.dirty).toBe(false);
  });
});

describe('刪節點', () => {
  it('開始節點刪不掉', () => {
    model.removeNode('start');
    expect(model.node('start')).toBeDefined();
    expect(model.dirty).toBe(false);
  });

  it('連它的連線一起刪掉', () => {
    model.addNode('agent');
    model.connect('start', undefined, 'agent-1');
    model.connect('agent-1', 'ok', 'end');
    expect(model.definition.edges).toHaveLength(2);

    model.removeNode('agent-1');
    expect(model.definition.edges).toEqual([]);
  });

  it('別人指到它的 resumeFrom 與 source 一起清掉', () => {
    model.addNode('agent');
    model.addNode('agent');
    model.addNode('condition');
    model.updateNode('agent-2', { config: { resumeFrom: 'agent-1' } });
    model.updateNode('condition-1', { config: { source: 'agent-1' } });

    model.removeNode('agent-1');

    const agent2 = model.node('agent-2');
    const condition = model.node('condition-1');
    expect(agent2?.type === 'agent' && agent2.config.resumeFrom).toBeUndefined();
    expect(condition?.type === 'condition' && condition.config.source).toBe('');
  });
});

describe('接線', () => {
  beforeEach(() => {
    model.addNode('agent');
  });

  it('開始節點接出去不帶出口', () => {
    expect(model.connect('start', undefined, 'agent-1')).toBeNull();
    expect(model.definition.edges).toEqual([{ from: 'start', to: 'agent-1' }]);
  });

  it('有出口的節點要指定自己的出口', () => {
    expect(model.connect('agent-1', 'ok', 'end')).toBeNull();
    expect(model.definition.edges).toEqual([{ from: 'agent-1', to: 'end', port: 'ok' }]);
  });

  it('同一個出口再接一次是改接，不是多一條', () => {
    model.connect('agent-1', 'ok', 'end');
    model.addNode('approval');
    expect(model.connect('agent-1', 'ok', 'approval-1')).toBeNull();
    expect(model.definition.edges).toEqual([{ from: 'agent-1', to: 'approval-1', port: 'ok' }]);
  });

  it('同一個節點的另一個出口是新的一條', () => {
    model.connect('agent-1', 'ok', 'end');
    model.connect('agent-1', 'fail', 'end');
    expect(model.definition.edges).toHaveLength(2);
  });

  it('不能接回自己', () => {
    expect(model.connect('agent-1', 'ok', 'agent-1')).toBe('不能接回自己');
    expect(model.definition.edges).toEqual([]);
  });

  it('不能接到開始節點', () => {
    expect(model.connect('agent-1', 'ok', 'start')).toBe('開始節點不能當終點');
  });

  it('出口不是這個型別的就拒絕', () => {
    expect(model.connect('agent-1', 'yes', 'end')).toBe('agent-1 的出口必須是 ok 或 fail');
    expect(model.connect('agent-1', undefined, 'end')).toBe('agent-1 的出口必須是 ok 或 fail');
    expect(model.definition.edges).toEqual([]);
  });

  it('開始節點不能帶出口，結束節點沒有出口', () => {
    expect(model.connect('start', 'ok', 'end')).toBe('開始節點的連線不能指定出口');
    expect(model.connect('end', undefined, 'agent-1')).toBe('結束節點沒有出口');
  });

  it('節點不存在就拒絕', () => {
    expect(model.connect('nope', 'ok', 'end')).toBe('找不到節點');
    expect(model.connect('agent-1', 'ok', 'nope')).toBe('找不到節點');
  });

  it('接不起來的時候不會變髒', () => {
    model.markSaved();
    model.connect('agent-1', 'yes', 'end');
    expect(model.dirty).toBe(false);
  });
});

describe('刪連線', () => {
  it('照索引刪掉一條', () => {
    model.addNode('agent');
    model.connect('start', undefined, 'agent-1');
    model.connect('agent-1', 'ok', 'end');
    model.removeEdge(0);
    expect(model.definition.edges).toEqual([{ from: 'agent-1', to: 'end', port: 'ok' }]);
  });

  it('索引超出範圍就什麼都不做', () => {
    model.removeEdge(3);
    model.removeEdge(-1);
    expect(model.dirty).toBe(false);
  });
});

describe('改節點內容', () => {
  it('只換 patch 裡有的欄位', () => {
    model.addNode('agent');
    model.updateNode('agent-1', { label: '實作', config: { prompt: '做事' } });
    const node = model.node('agent-1');
    expect(node?.label).toBe('實作');
    expect(node?.type === 'agent' && node.config).toMatchObject({
      kind: 'claude',
      prompt: '做事',
      cwd: '{{params.cwd}}',
      permission: 'readonly',
    });
  });

  it('不存在的節點什麼都不做', () => {
    model.updateNode('nope', { label: 'x' });
    expect(model.dirty).toBe(false);
  });
});

describe('驗證', () => {
  it('轉給 validateWorkflow：新畫布的結束節點還走不到', () => {
    expect(model.validate()).toEqual(['節點 end 從開始節點走不到']);
  });

  it('接起來就合法', () => {
    model.connect('start', undefined, 'end');
    expect(model.validate()).toEqual([]);
  });
});

describe('接點座標', () => {
  it('入口在左邊、標頭的中間', () => {
    expect(model.portAnchor('end', 'in')).toEqual({ x: 600, y: 120 + NODE_HEADER / 2 });
  });

  it('開始節點那個沒有名字的出口在右邊、標頭的中間', () => {
    expect(model.portAnchor('start', undefined)).toEqual({
      x: 40 + NODE_WIDTH,
      y: 120 + NODE_HEADER / 2,
    });
  });

  it('出口一列一個，照 NODE_PORTS 的順序往下排', () => {
    model.addNode('agent', { x: 100, y: 200 });
    expect(model.portAnchor('agent-1', 'ok')).toEqual({
      x: 100 + NODE_WIDTH,
      y: 200 + NODE_HEADER + PORT_ROW / 2,
    });
    expect(model.portAnchor('agent-1', 'fail')).toEqual({
      x: 100 + NODE_WIDTH,
      y: 200 + NODE_HEADER + PORT_ROW + PORT_ROW / 2,
    });
  });

  it('節點不存在時回原點', () => {
    expect(model.portAnchor('nope', 'in')).toEqual({ x: 0, y: 0 });
  });
});

describe('PORT_LABELS', () => {
  it('每一種出口都有中文名稱', () => {
    const ports = new Set<WorkflowPort>();
    for (const list of Object.values(NODE_PORTS)) for (const port of list) ports.add(port);
    for (const port of ports) expect(PORT_LABELS[port]).toBeTruthy();
    expect(Object.keys(PORT_LABELS)).toHaveLength(ports.size);
  });
});

describe('啟動參數', () => {
  it('新畫布一開始就是內建的那兩個，而且是自己的一份', () => {
    expect(model.definition.params).toEqual(DEFAULT_PARAMS);
    model.updateParam(0, { label: '改過' });
    expect(DEFAULT_PARAMS[0].label).toBe('任務');
  });

  it('加一個：名稱自動避開已經有的，型別預設是單行必填', () => {
    model.addParam();
    expect(model.definition.params?.at(-1)).toEqual({
      name: 'param1',
      label: 'param1',
      kind: 'text',
      required: true,
    });
    model.addParam();
    expect(model.definition.params?.map((p) => p.name)).toEqual([
      'task',
      'cwd',
      'param1',
      'param2',
    ]);
  });

  it('改一個：只動 patch 裡有的欄位', () => {
    model.addParam();
    model.updateParam(2, { name: 'branch', label: '分支' });
    expect(model.definition.params?.[2]).toEqual({
      name: 'branch',
      label: '分支',
      kind: 'text',
      required: true,
    });
  });

  it('刪一個', () => {
    model.removeParam(0);
    expect(model.definition.params?.map((p) => p.name)).toEqual(['cwd']);
    // 超出範圍就什麼都不做。
    model.removeParam(9);
    expect(model.definition.params).toHaveLength(1);
  });

  it('改參數會弄髒畫布，也會通知訂閱者', () => {
    let notified = 0;
    model.subscribe(() => (notified += 1));
    model.addParam();
    model.updateParam(0, { required: false });
    model.removeParam(0);
    expect(notified).toBe(3);
    expect(model.dirty).toBe(true);
  });

  /** 舊的 JSON 沒有這一欄，改的時候才把內建的那兩個補上去。*/
  it('載入沒宣告參數的舊定義：先當成內建的那兩個，改了才寫進定義', () => {
    model.load(saved(), 'custom');
    expect(model.definition.params).toBeUndefined();
    expect(model.params).toEqual(DEFAULT_PARAMS);
    model.addParam();
    expect(model.definition.params?.map((p) => p.name)).toEqual(['task', 'cwd', 'param1']);
  });
});
