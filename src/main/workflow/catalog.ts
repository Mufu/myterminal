import type { WorkflowDefinition, WorkflowInfo } from '../../shared/workflow';
import { findTemplate, templateInfos } from './templates';
import type { WorkflowStore } from './workflow-store';

/**
 * 內建範本與自訂工作流合起來的目錄：IPC 只問這裡，
 * 不必知道一個 id 是寫死的範本還是使用者存下來的。
 */
export function listWorkflows(store: WorkflowStore): WorkflowInfo[] {
  const custom = store.list().map(({ id, name }) => ({ id, name, builtin: false }));
  return [...templateInfos(), ...custom];
}

export function findWorkflow(id: string, store: WorkflowStore): WorkflowDefinition | undefined {
  return findTemplate(id) ?? store.get(id);
}
