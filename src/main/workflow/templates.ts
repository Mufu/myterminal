import type { WorkflowDefinition, WorkflowTemplateInfo } from '../../shared/workflow';

/**
 * 內建範本。就是一份 WorkflowDefinition —— 跟使用者之後在畫布上拉出來的東西
 * 是同一種資料，沒有第二套格式。position 是給 Phase 2 的畫布用的，
 * 由左到右排，只有「修正」掉到下面那一排 (它是回頭的那條線)。
 */
const IMPLEMENT_REVIEW_APPROVE: WorkflowDefinition = {
  version: 1,
  id: 'implement-review-approve',
  name: '實作 → 審查 → 批准',
  nodes: [
    { id: 'start', type: 'start', label: '開始', position: { x: 0, y: 0 } },
    {
      id: 'implement',
      type: 'agent',
      label: '實作',
      position: { x: 180, y: 0 },
      config: {
        kind: 'claude',
        prompt: '{{params.task}}',
        cwd: '{{params.cwd}}',
        allowEdits: true,
      },
    },
    {
      id: 'review',
      type: 'agent',
      label: '審查',
      position: { x: 360, y: 0 },
      config: {
        kind: 'claude',
        prompt:
          '審查目前工作目錄的變更是否完成「{{params.task}}」，最後一行只輸出 PASS 或 FAIL',
        cwd: '{{params.cwd}}',
        allowEdits: false,
      },
    },
    {
      id: 'check',
      type: 'condition',
      label: '檢查',
      position: { x: 540, y: 0 },
      config: { source: 'review', rule: { type: 'lastLineEquals', value: 'PASS' } },
    },
    {
      id: 'approve',
      type: 'approval',
      label: '批准',
      position: { x: 720, y: 0 },
      config: { question: '要保留這次的變更嗎？' },
    },
    {
      id: 'fix',
      type: 'agent',
      label: '修正',
      position: { x: 540, y: 160 },
      config: {
        kind: 'claude',
        prompt: '審查意見如下，請修正：{{review.text}}',
        cwd: '{{params.cwd}}',
        allowEdits: true,
        resumeFrom: 'implement',
        maxAttempts: 3,
      },
    },
    { id: 'end', type: 'end', label: '結束', position: { x: 900, y: 0 } },
  ],
  edges: [
    { from: 'start', to: 'implement' },
    { from: 'implement', to: 'review', port: 'ok' },
    { from: 'review', to: 'check', port: 'ok' },
    { from: 'check', to: 'approve', port: 'yes' },
    { from: 'check', to: 'fix', port: 'no' },
    { from: 'fix', to: 'review', port: 'ok' },
    { from: 'approve', to: 'end', port: 'approved' },
  ],
  // 沒有連線的出口 (implement / review / fix 的 fail、approve 的 rejected)
  // 就是「到此為止」：整個執行會被標成失敗，原因寫在 RunState.error 裡。
};

export const TEMPLATES: readonly WorkflowDefinition[] = [IMPLEMENT_REVIEW_APPROVE];

export function templateInfos(): WorkflowTemplateInfo[] {
  return TEMPLATES.map(({ id, name }) => ({ id, name }));
}

export function findTemplate(id: string): WorkflowDefinition | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
