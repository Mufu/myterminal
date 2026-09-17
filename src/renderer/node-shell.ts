import type { BaseShell } from '../shared/profile';
import { TYPE_LABELS as CLI_LABELS } from '../shared/profile';
import { findRole } from '../shared/roles';
import type { TemplateResolver } from '../shared/template';
import { renderTemplate } from '../shared/template';
import type { RunState, WorkflowNode } from '../shared/workflow';

/**
 * 畫布上的「手動操作」需要的純函式：這個節點要在哪個目錄開終端機、
 * 要把什麼提示交給人。跟執行那一側共用 shared/template 的替換，
 * 差別只在代不出來的時候 —— 畫布上原樣留著，讓人自己看得到還缺什麼。
 */

export type AgentNode = Extract<WorkflowNode, { type: 'agent' }>;

/** 只代得出 {{params.x}}，而且要有那一次執行；其餘 (上游輸出) 都留著。*/
const fromRun =
  (run: RunState | null): TemplateResolver =>
  (head, field) =>
    head === 'params' ? run?.params[field] : undefined;

/** 節點的工作目錄；代不出來 (或沒填) 時回 null，由呼叫者去問人。*/
export function resolveNodeCwd(node: AgentNode, run: RunState | null): string | null {
  const template = node.config.cwd?.trim();
  if (!template) return null;
  const cwd = renderTemplate(template, fromRun(run)).trim();
  // 還留著 {{…}} 就是代不出來。
  return cwd && !cwd.includes('{{') ? cwd : null;
}

/** 節點的提示，前面補上角色的前置指示 —— 跟編排層送給 CLI 的是同一段話。*/
export function renderNodePrompt(node: AgentNode, run: RunState | null): string {
  const prompt = renderTemplate(node.config.prompt, fromRun(run));
  const role = node.config.role ? findRole(node.config.role) : undefined;
  return role ? `${role.systemPrompt}\n\n${prompt}` : prompt;
}

/** 手動開出來的工作階段叫什麼：一眼看得出是哪一份工作流的哪一個節點。*/
export function shellSessionName(workflowName: string, node: AgentNode): string {
  return `${workflowName} · ${node.label} shell`;
}

export function cliSessionName(workflowName: string, node: AgentNode): string {
  return `${workflowName} · ${node.label} ${CLI_LABELS[node.config.kind]}`;
}

/** 沒選過就是 PowerShell。*/
export function nodeShell(node: AgentNode): BaseShell {
  return node.config.shell ?? 'powershell';
}
