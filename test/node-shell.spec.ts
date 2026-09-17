import { describe, it, expect } from 'vitest';
import {
  cliSessionName,
  nodeShell,
  renderNodePrompt,
  resolveNodeCwd,
  shellSessionName,
} from '../src/renderer/node-shell';
import type { AgentNode } from '../src/renderer/node-shell';
import type { AgentNodeConfig, RunState } from '../src/shared/workflow';
import { findRole } from '../src/shared/roles';

/**
 * 畫布上的「手動操作」：要在哪個目錄開終端機、要把什麼提示交出去。
 * 兩件事都是純函式，其餘 (按鈕、對話框) 看 e2e/editor-shell.spec.ts。
 */

const node = (config: Partial<AgentNodeConfig> = {}, label = 'Agent'): AgentNode => ({
  id: 'agent-1',
  type: 'agent',
  label,
  position: { x: 0, y: 0 },
  config: { kind: 'claude', prompt: '', cwd: '{{params.cwd}}', permission: 'readonly', ...config },
});

const run = (params: Record<string, string>): RunState => ({
  runId: 'run-1',
  workflowId: 'wf-1',
  name: '我的流程',
  status: 'done',
  params,
  nodes: {},
  totalCostUsd: 0,
  startedAt: 1,
});

describe('resolveNodeCwd', () => {
  it('有執行時 {{params.cwd}} 代得出來', () => {
    expect(resolveNodeCwd(node(), run({ cwd: 'D:\work' }))).toBe('D:\work');
  });

  it('沒有執行就代不出來 (要問使用者)', () => {
    expect(resolveNodeCwd(node(), null)).toBeNull();
  });

  it('執行裡沒有那個參數也是代不出來', () => {
    expect(resolveNodeCwd(node(), run({ task: '做事' }))).toBeNull();
  });

  it('寫死的路徑直接用，不必有執行', () => {
    expect(resolveNodeCwd(node({ cwd: 'D:\repo\myterminal' }), null)).toBe('D:\repo\myterminal');
  });

  it('沒填工作目錄就是 null', () => {
    expect(resolveNodeCwd(node({ cwd: '' }), run({ cwd: 'D:\work' }))).toBeNull();
    expect(resolveNodeCwd(node({ cwd: '  ' }), null)).toBeNull();
  });

  it('只代得出一半 (路徑裡還有別的樣板) 也算代不出來', () => {
    const mixed = node({ cwd: '{{params.cwd}}\{{params.sub}}' });
    expect(resolveNodeCwd(mixed, run({ cwd: 'D:\work' }))).toBeNull();
  });
});

describe('renderNodePrompt', () => {
  it('有執行就代入啟動參數', () => {
    const agent = node({ prompt: '請做：{{params.task}}' });
    expect(renderNodePrompt(agent, run({ task: '寫 README' }))).toBe('請做：寫 README');
  });

  it('沒有執行、或是上游節點的輸出，都原樣留著讓人自己填', () => {
    const agent = node({ prompt: '依照 {{agent-2.text}} 修正 {{params.task}}' });
    expect(renderNodePrompt(agent, null)).toBe('依照 {{agent-2.text}} 修正 {{params.task}}');
    expect(renderNodePrompt(agent, run({ task: '打字' }))).toBe('依照 {{agent-2.text}} 修正 打字');
  });

  it('有角色時前面加上角色的前置指示，中間空一行', () => {
    const agent = node({ prompt: '做事', role: 'coder' });
    expect(renderNodePrompt(agent, null)).toBe(`${findRole('coder')?.systemPrompt}\n\n做事`);
  });
});

describe('工作階段的名字與終端機', () => {
  it('名字看得出是哪一份工作流的哪一個節點', () => {
    expect(shellSessionName('我的流程', node({}, '實作'))).toBe('我的流程 · 實作 shell');
    expect(cliSessionName('我的流程', node({ kind: 'opencode' }, '實作'))).toBe(
      '我的流程 · 實作 OpenCode',
    );
  });

  it('沒選終端機就是 PowerShell', () => {
    expect(nodeShell(node())).toBe('powershell');
    expect(nodeShell(node({ shell: 'wsl' }))).toBe('wsl');
  });
});
