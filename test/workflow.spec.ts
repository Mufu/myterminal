import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '../src/shared/workflow';
import { CLI_TYPES } from '../src/shared/profile';
import type {
  ConditionRule,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from '../src/shared/workflow';
import { TEMPLATES } from '../src/main/workflow/templates';
import type { AgentRole } from '../src/shared/roles';
import type { AgentPermission } from '../src/shared/agent';
import { permissionFromAllowEdits } from '../src/shared/agent';

const at = { x: 0, y: 0 };

const start = (id = 'start'): WorkflowNode => ({ id, type: 'start', label: '開始', position: at });
const end = (id = 'end'): WorkflowNode => ({ id, type: 'end', label: '結束', position: at });
const agent = (id: string): WorkflowNode => ({
  id,
  type: 'agent',
  label: id,
  position: at,
  config: { kind: 'claude', prompt: 'x', cwd: 'D:/work', permission: 'readonly' },
});
const condition = (id: string, source: string, rule?: ConditionRule): WorkflowNode => ({
  id,
  type: 'condition',
  label: id,
  position: at,
  config: { source, rule: rule ?? { type: 'lastLineEquals', value: 'PASS' } },
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

  it('agent 節點的四支 CLI 都收', () => {
    for (const kind of CLI_TYPES) {
      const one = minimal();
      const node = one.nodes.find((n) => n.type === 'agent');
      if (node?.type === 'agent') node.config.kind = kind;
      expect(validateWorkflow(one)).toEqual([]);
    }
  });

  /** 「手動操作」要在哪個終端機裡開；執行那一側不看它，所以驗證只要收下。*/
  it('agent 節點選了終端機也是合法的', () => {
    for (const shell of ['powershell', 'wsl'] as const) {
      const one = minimal();
      const node = one.nodes.find((n) => n.type === 'agent');
      if (node?.type === 'agent') node.config.shell = shell;
      expect(validateWorkflow(one)).toEqual([]);
    }
  });

  it('開始節點必須剛好一個', () => {
    const none = def([agent('a'), end()], []);
    expect(validateWorkflow(none).join()).toContain('剛好有一個開始節點');

    const two = minimal();
    two.nodes.push(start('start2'));
    expect(validateWorkflow(two).join()).toContain('剛好有一個開始節點');
  });

  it('工作流名稱不能是空的', () => {
    const blank = minimal();
    blank.name = '  ';
    expect(validateWorkflow(blank)).toEqual(['工作流名稱不能是空的']);
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

  it('舊資料的 allowEdits 兩檔對到三檔的哪兩檔', () => {
    expect(permissionFromAllowEdits(true)).toBe('edit');
    expect(permissionFromAllowEdits(false)).toBe('readonly');
  });

  it('agent 節點的角色必須是內建的那五個之一', () => {
    const ok = minimal();
    (ok.nodes[1] as Extract<WorkflowNode, { type: 'agent' }>).config.role = 'reviewer';
    expect(validateWorkflow(ok)).toEqual([]);

    const bad = minimal();
    (bad.nodes[1] as Extract<WorkflowNode, { type: 'agent' }>).config.role = 'boss' as AgentRole;
    expect(validateWorkflow(bad)).toEqual(['節點 a 的角色不存在：boss']);
  });

  it('agent 節點的權限必須是三檔之一，沒寫也可以 (預設唯讀)', () => {
    const ok = minimal();
    const config = (ok.nodes[1] as Extract<WorkflowNode, { type: 'agent' }>).config;
    config.permission = 'full';
    expect(validateWorkflow(ok)).toEqual([]);
    delete config.permission;
    expect(validateWorkflow(ok)).toEqual([]);

    const bad = minimal();
    (bad.nodes[1] as Extract<WorkflowNode, { type: 'agent' }>).config.permission =
      'yolo' as AgentPermission;
    expect(validateWorkflow(bad)).toEqual(['節點 a 的權限不存在：yolo']);
  });

  it('agent 節點的提示與工作目錄不能是空的', () => {
    const blank = minimal();
    const config = (blank.nodes[1] as Extract<WorkflowNode, { type: 'agent' }>).config;
    config.prompt = '  ';
    config.cwd = '';
    expect(validateWorkflow(blank)).toEqual([
      '節點 a 的提示不能是空的',
      '節點 a 的工作目錄不能是空的',
    ]);

    const missing = minimal();
    delete (missing.nodes[1] as Extract<WorkflowNode, { type: 'agent' }>).config.cwd;
    expect(validateWorkflow(missing)).toEqual(['節點 a 的工作目錄不能是空的']);
  });

  /** 來源沒設或指到不是 agent 的節點，執行時那個條件永遠走「否」。*/
  it('condition 的來源必須是存在的 agent 節點', () => {
    const wired = (source: string, extra: WorkflowNode[] = []): WorkflowDefinition =>
      def(
        [start(), agent('a'), condition('c', source), end(), ...extra],
        [
          { from: 'start', to: 'a' },
          { from: 'a', to: 'c', port: 'ok' },
          { from: 'a', to: 'end', port: 'fail' },
          { from: 'c', to: 'end', port: 'yes' },
          { from: 'c', to: 'end', port: 'no' },
        ],
      );

    expect(validateWorkflow(wired('a'))).toEqual([]);
    expect(validateWorkflow(wired(''))).toEqual(['節點 c 的條件來源不存在：']);
    expect(validateWorkflow(wired('nope'))).toEqual(['節點 c 的條件來源不存在：nope']);
    // 指到 start 這種沒有輸出的節點也不算數。
    expect(validateWorkflow(wired('start'))).toEqual(['節點 c 的條件來源不存在：start']);
  });

  it('condition 的正規式編不起來就報錯', () => {
    const bad = def(
      [start(), agent('a'), condition('c', 'a', { type: 'regex', pattern: '(' }), end()],
      [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'c', port: 'ok' },
        { from: 'a', to: 'end', port: 'fail' },
        { from: 'c', to: 'end', port: 'yes' },
        { from: 'c', to: 'end', port: 'no' },
      ],
    );
    expect(validateWorkflow(bad)).toEqual(['節點 c 的正規式無效']);
  });

  it('內建範本是合法的', () => {
    for (const template of TEMPLATES) expect(validateWorkflow(template)).toEqual([]);
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
