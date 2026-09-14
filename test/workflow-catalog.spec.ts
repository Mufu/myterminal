import { describe, it, expect, beforeEach } from 'vitest';
import { listWorkflows, findWorkflow } from '../src/main/workflow/catalog';
import { WorkflowStore } from '../src/main/workflow/workflow-store';
import { minimalWorkflow } from './fakes/fake-workflow';

let store: WorkflowStore;

beforeEach(() => {
  let content: string | null = null;
  store = new WorkflowStore(
    () => content,
    (next) => void (content = next),
  );
});

describe('工作流目錄', () => {
  it('只有內建範本時列出內建的', () => {
    expect(listWorkflows(store)).toEqual([
      { id: 'implement-review-approve', name: '實作 → 審查 → 批准', builtin: true },
    ]);
  });

  it('自訂的排在內建的後面，而且標成不是內建', () => {
    store.save(minimalWorkflow('mine', '我的'));
    expect(listWorkflows(store).map((w) => [w.id, w.builtin])).toEqual([
      ['implement-review-approve', true],
      ['mine', false],
    ]);
  });

  it('findWorkflow 先找內建範本，再找自訂的', () => {
    store.save(minimalWorkflow('mine'));
    expect(findWorkflow('implement-review-approve', store)?.name).toBe('實作 → 審查 → 批准');
    expect(findWorkflow('mine', store)?.id).toBe('mine');
    expect(findWorkflow('沒有這個', store)).toBeUndefined();
  });
});
