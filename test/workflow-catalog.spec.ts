import { describe, it, expect, beforeEach } from 'vitest';
import { listWorkflows, findWorkflow } from '../src/main/workflow/catalog';
import { WorkflowStore } from '../src/main/workflow/workflow-store';
import { TEMPLATES } from '../src/main/workflow/templates';
import { minimalWorkflow } from './fakes/fake-workflow';
import { DEFAULT_PARAMS } from '../src/shared/workflow';

let store: WorkflowStore;

beforeEach(() => {
  let content: string | null = null;
  store = new WorkflowStore(
    () => content,
    (next) => void (content = next),
  );
});

describe('工作流目錄', () => {
  it('只有內建範本時列出內建的，順序跟 TEMPLATES 一樣、說明也帶著', () => {
    const infos = listWorkflows(store);
    expect(infos.map((w) => w.id)).toEqual(TEMPLATES.map((t) => t.id));
    expect(infos.every((w) => w.builtin)).toBe(true);
    expect(infos[0]).toEqual({
      id: 'implement-review-approve',
      name: '實作 → 審查 → 批准',
      description: TEMPLATES[0].description,
      params: DEFAULT_PARAMS,
      builtin: true,
    });
  });

  it('自訂的排在內建的後面，而且標成不是內建', () => {
    store.save(minimalWorkflow('mine', '我的'));
    const infos = listWorkflows(store);
    expect(infos[0]).toMatchObject({ id: 'implement-review-approve', builtin: true });
    expect(infos.at(-1)).toMatchObject({ id: 'mine', builtin: false });
    // 沒宣告參數的自訂工作流，清單上補的是內建的那兩個。
    expect(infos.at(-1)?.params).toEqual(DEFAULT_PARAMS);
    expect(infos).toHaveLength(TEMPLATES.length + 1);
  });

  it('findWorkflow 先找內建範本，再找自訂的', () => {
    store.save(minimalWorkflow('mine'));
    expect(findWorkflow('implement-review-approve', store)?.name).toBe('實作 → 審查 → 批准');
    expect(findWorkflow('mine', store)?.id).toBe('mine');
    expect(findWorkflow('沒有這個', store)).toBeUndefined();
  });
});
