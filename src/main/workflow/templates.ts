import type { WorkflowDefinition, WorkflowInfo } from '../../shared/workflow';
import { DEFAULT_PARAMS, paramsOf } from '../../shared/workflow';

/**
 * 內建範本。就是一份 WorkflowDefinition —— 跟使用者在畫布上拉出來的東西
 * 是同一種資料，沒有第二套格式。position 是給畫布用的，
 * 由左到右排，只有「修正」掉到下面那一排 (它是回頭的那條線)。
 *
 * 每一份都只吃 {{params.task}} 與 {{params.cwd}} 兩個啟動參數 (明寫成 params，
 * 畫布的「啟動參數」面板才看得到)，
 * 節點的提示只補「這一步要做什麼」，職責與語氣留給 shared/roles.ts 的角色。
 * 會被條件看的節點，提示最後一定有一句「最後一行只輸出 X 或 Y」。
 */
const IMPLEMENT_REVIEW_APPROVE: WorkflowDefinition = {
  version: 1,
  id: 'implement-review-approve',
  name: '實作 → 審查 → 批准',
  description: '把任務丟給工程師做，審查者看過，最後停下來讓你決定要不要保留。',
  params: [...DEFAULT_PARAMS],
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
        permission: 'edit',
        role: 'coder',
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
        permission: 'readonly',
        role: 'reviewer',
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
        permission: 'edit',
        role: 'coder',
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

/** 從一句需求走完整條線；設計與變更各停一次讓人點頭。*/
const SOFTWARE_DEV: WorkflowDefinition = {
  version: 1,
  id: 'software-dev',
  name: '軟體開發：需求 → 設計 → 實作 → 測試 → 審查',
  description: '把一句需求走完整條線：拆驗收清單、設計、實作、補測試、審查，中間批准兩次。',
  params: [...DEFAULT_PARAMS],
  nodes: [
    { id: 'start', type: 'start', label: '開始', position: { x: 0, y: 0 } },
    {
      id: 'pm',
      type: 'agent',
      label: '需求',
      position: { x: 180, y: 0 },
      config: {
        kind: 'claude',
        prompt:
          '把「{{params.task}}」拆成一份可驗收的工作項目清單，每一項寫清楚完成的判準。\n' +
          '最後一行只輸出 DONE',
        cwd: '{{params.cwd}}',
        permission: 'readonly',
        role: 'pm',
      },
    },
    {
      id: 'architect',
      type: 'agent',
      label: '設計',
      position: { x: 360, y: 0 },
      config: {
        kind: 'claude',
        prompt:
          '依照這份驗收清單給出設計方案：要動哪些模組、介面長什麼樣、要改哪些檔案。\n' +
          '{{pm.text}}\n' +
          '最後一行只輸出 DONE',
        cwd: '{{params.cwd}}',
        permission: 'readonly',
        role: 'architect',
      },
    },
    {
      id: 'approve-design',
      type: 'approval',
      label: '批准設計',
      position: { x: 540, y: 0 },
      config: { question: '設計方案可以嗎？' },
    },
    {
      id: 'coder',
      type: 'agent',
      label: '實作',
      position: { x: 720, y: 0 },
      config: {
        kind: 'claude',
        prompt: '依照這份設計實作「{{params.task}}」：\n{{architect.text}}',
        cwd: '{{params.cwd}}',
        permission: 'edit',
        role: 'coder',
      },
    },
    {
      id: 'tester',
      type: 'agent',
      label: '測試',
      position: { x: 900, y: 0 },
      config: {
        kind: 'claude',
        prompt: '為「{{params.task}}」補上測試並執行。\n最後一行只輸出 PASS 或 FAIL',
        cwd: '{{params.cwd}}',
        permission: 'edit',
        role: 'tester',
      },
    },
    {
      id: 'check-test',
      type: 'condition',
      label: '測試過了嗎',
      position: { x: 1080, y: 0 },
      config: { source: 'tester', rule: { type: 'lastLineEquals', value: 'PASS' } },
    },
    {
      id: 'reviewer',
      type: 'agent',
      label: '審查',
      position: { x: 1260, y: 0 },
      config: {
        kind: 'claude',
        prompt: '審查這次的變更有沒有完成「{{params.task}}」，最後一行只輸出 PASS 或 FAIL',
        cwd: '{{params.cwd}}',
        permission: 'readonly',
        role: 'reviewer',
      },
    },
    {
      id: 'check-review',
      type: 'condition',
      label: '審查過了嗎',
      position: { x: 1440, y: 0 },
      config: { source: 'reviewer', rule: { type: 'lastLineEquals', value: 'PASS' } },
    },
    {
      id: 'approve-keep',
      type: 'approval',
      label: '批准',
      position: { x: 1620, y: 0 },
      config: { question: '保留這次的變更嗎？' },
    },
    {
      id: 'coder-fix',
      type: 'agent',
      label: '修測試',
      position: { x: 1080, y: 160 },
      config: {
        kind: 'claude',
        prompt: '測試沒過，依照這份結果修正：\n{{tester.text}}',
        cwd: '{{params.cwd}}',
        permission: 'edit',
        role: 'coder',
        resumeFrom: 'coder',
        maxAttempts: 3,
      },
    },
    {
      id: 'coder-fix2',
      type: 'agent',
      label: '修審查',
      position: { x: 1440, y: 160 },
      config: {
        kind: 'claude',
        prompt: '審查意見如下，請修正：\n{{reviewer.text}}',
        cwd: '{{params.cwd}}',
        permission: 'edit',
        role: 'coder',
        resumeFrom: 'coder',
        maxAttempts: 3,
      },
    },
    { id: 'end', type: 'end', label: '結束', position: { x: 1800, y: 0 } },
  ],
  edges: [
    { from: 'start', to: 'pm' },
    { from: 'pm', to: 'architect', port: 'ok' },
    { from: 'architect', to: 'approve-design', port: 'ok' },
    { from: 'approve-design', to: 'coder', port: 'approved' },
    { from: 'coder', to: 'tester', port: 'ok' },
    { from: 'tester', to: 'check-test', port: 'ok' },
    { from: 'check-test', to: 'reviewer', port: 'yes' },
    { from: 'check-test', to: 'coder-fix', port: 'no' },
    { from: 'coder-fix', to: 'tester', port: 'ok' },
    { from: 'reviewer', to: 'check-review', port: 'ok' },
    { from: 'check-review', to: 'approve-keep', port: 'yes' },
    { from: 'check-review', to: 'coder-fix2', port: 'no' },
    { from: 'coder-fix2', to: 'reviewer', port: 'ok' },
    { from: 'approve-keep', to: 'end', port: 'approved' },
  ],
};

/** 先重現再修：重現不出來就停在「無法重現」那個結束節點。*/
const BUG_FIX: WorkflowDefinition = {
  version: 1,
  id: 'bug-fix',
  name: '修 bug：重現 → 修正 → 驗證 → 審查',
  description: '先寫一個會失敗的測試把 bug 重現出來，再修到它會過；重現不出來就停下來。',
  params: [...DEFAULT_PARAMS],
  nodes: [
    { id: 'start', type: 'start', label: '開始', position: { x: 0, y: 0 } },
    {
      id: 'coder',
      type: 'agent',
      label: '重現',
      position: { x: 180, y: 0 },
      config: {
        kind: 'claude',
        prompt:
          '依照「{{params.task}}」寫一個會失敗的測試把這個 bug 重現出來，這一步先不要修它。\n' +
          '最後一行只輸出 REPRODUCED 或 NOT_REPRODUCED',
        cwd: '{{params.cwd}}',
        permission: 'edit',
        role: 'coder',
      },
    },
    {
      id: 'check-repro',
      type: 'condition',
      label: '重現到了嗎',
      position: { x: 360, y: 0 },
      config: { source: 'coder', rule: { type: 'lastLineEquals', value: 'REPRODUCED' } },
    },
    {
      id: 'coder-fix',
      type: 'agent',
      label: '修正',
      position: { x: 540, y: 0 },
      config: {
        kind: 'claude',
        prompt:
          '修到剛才那個測試會過，不要改測試本身，也不要動無關的地方。\n' +
          '最後一行只輸出 PASS 或 FAIL',
        cwd: '{{params.cwd}}',
        permission: 'edit',
        role: 'coder',
        resumeFrom: 'coder',
        maxAttempts: 3,
      },
    },
    {
      id: 'check-fix',
      type: 'condition',
      label: '測試過了嗎',
      position: { x: 720, y: 0 },
      config: { source: 'coder-fix', rule: { type: 'lastLineEquals', value: 'PASS' } },
    },
    {
      id: 'reviewer',
      type: 'agent',
      label: '審查',
      position: { x: 900, y: 0 },
      config: {
        kind: 'claude',
        prompt:
          '審查這次的修正有沒有真的解掉「{{params.task}}」，有沒有連帶弄壞別的地方。\n' +
          '最後一行只輸出 PASS 或 FAIL',
        cwd: '{{params.cwd}}',
        permission: 'readonly',
        role: 'reviewer',
      },
    },
    {
      id: 'check-review',
      type: 'condition',
      label: '審查過了嗎',
      position: { x: 1080, y: 0 },
      config: { source: 'reviewer', rule: { type: 'lastLineEquals', value: 'PASS' } },
    },
    {
      id: 'approve',
      type: 'approval',
      label: '批准',
      position: { x: 1260, y: 0 },
      config: { question: '要保留這次的修正嗎？' },
    },
    { id: 'end', type: 'end', label: '結束', position: { x: 1440, y: 0 } },
    { id: 'no-repro', type: 'end', label: '無法重現', position: { x: 360, y: 160 } },
  ],
  edges: [
    { from: 'start', to: 'coder' },
    { from: 'coder', to: 'check-repro', port: 'ok' },
    { from: 'check-repro', to: 'coder-fix', port: 'yes' },
    { from: 'check-repro', to: 'no-repro', port: 'no' },
    { from: 'coder-fix', to: 'check-fix', port: 'ok' },
    { from: 'check-fix', to: 'reviewer', port: 'yes' },
    { from: 'check-fix', to: 'coder-fix', port: 'no' },
    { from: 'reviewer', to: 'check-review', port: 'ok' },
    { from: 'check-review', to: 'approve', port: 'yes' },
    { from: 'check-review', to: 'coder-fix', port: 'no' },
    { from: 'approve', to: 'end', port: 'approved' },
  ],
};

/** 一個節點就跑完，一個檔案都不會動。*/
const CODE_REVIEW: WorkflowDefinition = {
  version: 1,
  id: 'code-review',
  name: '程式碼審查（唯讀）',
  description: '只看不改：審查指定的範圍或目前工作目錄的變更，依嚴重度列出問題。',
  params: [...DEFAULT_PARAMS],
  nodes: [
    { id: 'start', type: 'start', label: '開始', position: { x: 0, y: 0 } },
    {
      id: 'reviewer',
      type: 'agent',
      label: '審查',
      position: { x: 180, y: 0 },
      config: {
        kind: 'claude',
        prompt:
          '審查「{{params.task}}」指定的範圍；沒有指定就審查目前工作目錄的變更。\n' +
          '依嚴重度列出問題，每一項寫清楚在哪個檔案的第幾行。\n' +
          '最後一行只輸出 PASS 或 FAIL',
        cwd: '{{params.cwd}}',
        permission: 'readonly',
        role: 'reviewer',
      },
    },
    { id: 'end', type: 'end', label: '結束', position: { x: 360, y: 0 } },
  ],
  edges: [
    { from: 'start', to: 'reviewer' },
    { from: 'reviewer', to: 'end', port: 'ok' },
  ],
};

/** 補測試：跑到綠，再讓審查者確認那些測試有意義。*/
const WRITE_TESTS: WorkflowDefinition = {
  version: 1,
  id: 'write-tests',
  name: '補測試',
  description: '為指定的範圍補測試並跑到綠，再確認測試有意義、沒有為了變綠改產品程式碼。',
  params: [...DEFAULT_PARAMS],
  nodes: [
    { id: 'start', type: 'start', label: '開始', position: { x: 0, y: 0 } },
    {
      id: 'tester',
      type: 'agent',
      label: '寫測試',
      position: { x: 180, y: 0 },
      config: {
        kind: 'claude',
        prompt:
          '為「{{params.task}}」指定的範圍撰寫測試並執行。\n最後一行只輸出 PASS 或 FAIL',
        cwd: '{{params.cwd}}',
        permission: 'edit',
        role: 'tester',
      },
    },
    {
      id: 'check-tests',
      type: 'condition',
      label: '測試過了嗎',
      position: { x: 360, y: 0 },
      config: { source: 'tester', rule: { type: 'lastLineEquals', value: 'PASS' } },
    },
    {
      id: 'reviewer',
      type: 'agent',
      label: '審查',
      position: { x: 540, y: 0 },
      config: {
        kind: 'claude',
        prompt:
          '檢查這次新增的測試有沒有意義（真的抓得到錯），以及有沒有為了讓它變綠而改動產品程式碼。\n' +
          '最後一行只輸出 PASS 或 FAIL',
        cwd: '{{params.cwd}}',
        permission: 'readonly',
        role: 'reviewer',
      },
    },
    {
      id: 'check-review',
      type: 'condition',
      label: '審查過了嗎',
      position: { x: 720, y: 0 },
      config: { source: 'reviewer', rule: { type: 'lastLineEquals', value: 'PASS' } },
    },
    {
      id: 'approve',
      type: 'approval',
      label: '批准',
      position: { x: 900, y: 0 },
      config: { question: '要保留這些測試嗎？' },
    },
    {
      id: 'tester-fix',
      type: 'agent',
      label: '修測試',
      position: { x: 360, y: 160 },
      config: {
        kind: 'claude',
        prompt:
          '測試沒過，修到會過；只能改測試，不要動產品程式碼。\n最後一行只輸出 PASS 或 FAIL',
        cwd: '{{params.cwd}}',
        permission: 'edit',
        role: 'tester',
        resumeFrom: 'tester',
        maxAttempts: 3,
      },
    },
    {
      id: 'check-fix',
      type: 'condition',
      label: '修好了嗎',
      position: { x: 540, y: 160 },
      config: { source: 'tester-fix', rule: { type: 'lastLineEquals', value: 'PASS' } },
    },
    { id: 'end', type: 'end', label: '結束', position: { x: 1080, y: 0 } },
  ],
  edges: [
    { from: 'start', to: 'tester' },
    { from: 'tester', to: 'check-tests', port: 'ok' },
    { from: 'check-tests', to: 'reviewer', port: 'yes' },
    { from: 'check-tests', to: 'tester-fix', port: 'no' },
    { from: 'tester-fix', to: 'check-fix', port: 'ok' },
    { from: 'check-fix', to: 'reviewer', port: 'yes' },
    { from: 'check-fix', to: 'tester-fix', port: 'no' },
    { from: 'reviewer', to: 'check-review', port: 'ok' },
    { from: 'check-review', to: 'approve', port: 'yes' },
    { from: 'check-review', to: 'tester-fix', port: 'no' },
    { from: 'approve', to: 'end', port: 'approved' },
  ],
};

/** 先看方案再動手：第一個批准就是「這個重構要不要做」。*/
const REFACTOR: WorkflowDefinition = {
  version: 1,
  id: 'refactor',
  name: '重構：方案 → 批准 → 執行 → 測試',
  description: '架構師先提重構方案與風險，你點頭之後才動手，改完跑既有測試確認行為沒變。',
  params: [...DEFAULT_PARAMS],
  nodes: [
    { id: 'start', type: 'start', label: '開始', position: { x: 0, y: 0 } },
    {
      id: 'architect',
      type: 'agent',
      label: '方案',
      position: { x: 180, y: 0 },
      config: {
        kind: 'claude',
        prompt:
          '針對「{{params.task}}」提出重構方案：要動哪些地方、分幾步做、各有什麼風險。\n' +
          '最後一行只輸出 DONE',
        cwd: '{{params.cwd}}',
        permission: 'readonly',
        role: 'architect',
      },
    },
    {
      id: 'approve-plan',
      type: 'approval',
      label: '批准方案',
      position: { x: 360, y: 0 },
      config: { question: '照這個方案重構嗎？' },
    },
    {
      id: 'coder',
      type: 'agent',
      label: '執行',
      position: { x: 540, y: 0 },
      config: {
        kind: 'claude',
        prompt: '照這個方案重構，只改結構不改行為：\n{{architect.text}}',
        cwd: '{{params.cwd}}',
        permission: 'edit',
        role: 'coder',
      },
    },
    {
      id: 'tester',
      type: 'agent',
      label: '測試',
      position: { x: 720, y: 0 },
      config: {
        kind: 'claude',
        prompt: '跑既有的測試，確認行為跟重構前一樣。\n最後一行只輸出 PASS 或 FAIL',
        cwd: '{{params.cwd}}',
        permission: 'edit',
        role: 'tester',
      },
    },
    {
      id: 'check-test',
      type: 'condition',
      label: '測試過了嗎',
      position: { x: 900, y: 0 },
      config: { source: 'tester', rule: { type: 'lastLineEquals', value: 'PASS' } },
    },
    {
      id: 'reviewer',
      type: 'agent',
      label: '審查',
      position: { x: 1080, y: 0 },
      config: {
        kind: 'claude',
        prompt:
          '審查這次重構有沒有不小心改到行為，有沒有留下沒清掉的東西。\n' +
          '最後一行只輸出 PASS 或 FAIL',
        cwd: '{{params.cwd}}',
        permission: 'readonly',
        role: 'reviewer',
      },
    },
    {
      id: 'check-review',
      type: 'condition',
      label: '審查過了嗎',
      position: { x: 1260, y: 0 },
      config: { source: 'reviewer', rule: { type: 'lastLineEquals', value: 'PASS' } },
    },
    {
      id: 'approve-keep',
      type: 'approval',
      label: '批准',
      position: { x: 1440, y: 0 },
      config: { question: '要保留這次的重構嗎？' },
    },
    {
      id: 'coder-fix',
      type: 'agent',
      label: '修正',
      position: { x: 900, y: 160 },
      config: {
        kind: 'claude',
        prompt: '沒過，依照這份結果修正，行為要跟重構前一樣：\n{{tester.text}}',
        cwd: '{{params.cwd}}',
        permission: 'edit',
        role: 'coder',
        resumeFrom: 'coder',
        maxAttempts: 3,
      },
    },
    { id: 'end', type: 'end', label: '結束', position: { x: 1620, y: 0 } },
  ],
  edges: [
    { from: 'start', to: 'architect' },
    { from: 'architect', to: 'approve-plan', port: 'ok' },
    { from: 'approve-plan', to: 'coder', port: 'approved' },
    { from: 'coder', to: 'tester', port: 'ok' },
    { from: 'tester', to: 'check-test', port: 'ok' },
    { from: 'check-test', to: 'reviewer', port: 'yes' },
    { from: 'check-test', to: 'coder-fix', port: 'no' },
    { from: 'coder-fix', to: 'tester', port: 'ok' },
    { from: 'reviewer', to: 'check-review', port: 'ok' },
    { from: 'check-review', to: 'approve-keep', port: 'yes' },
    { from: 'check-review', to: 'coder-fix', port: 'no' },
    { from: 'approve-keep', to: 'end', port: 'approved' },
  ],
};

/** 兩個唯讀節點，一個檔案都不會動。*/
const PLAN_ONLY: WorkflowDefinition = {
  version: 1,
  id: 'plan-only',
  name: '需求分析（只規劃不動碼）',
  description: '只規劃不動程式碼：拆出可驗收的工作項目與待釐清的問題，再給實作順序。',
  params: [...DEFAULT_PARAMS],
  nodes: [
    { id: 'start', type: 'start', label: '開始', position: { x: 0, y: 0 } },
    {
      id: 'pm',
      type: 'agent',
      label: '拆需求',
      position: { x: 180, y: 0 },
      config: {
        kind: 'claude',
        prompt: '把「{{params.task}}」拆成可驗收的工作項目，另外列出需要先問清楚的問題。',
        cwd: '{{params.cwd}}',
        permission: 'readonly',
        role: 'pm',
      },
    },
    {
      id: 'architect',
      type: 'agent',
      label: '實作順序',
      position: { x: 360, y: 0 },
      config: {
        kind: 'claude',
        prompt: '依照這份清單給出實作順序，以及每一步要動哪些檔案：\n{{pm.text}}',
        cwd: '{{params.cwd}}',
        permission: 'readonly',
        role: 'architect',
      },
    },
    { id: 'end', type: 'end', label: '結束', position: { x: 540, y: 0 } },
  ],
  edges: [
    { from: 'start', to: 'pm' },
    { from: 'pm', to: 'architect', port: 'ok' },
    { from: 'architect', to: 'end', port: 'ok' },
  ],
};

/** 換一支 CLI 來審：實作是 claude，審查是 codex。*/
const CROSS_REVIEW: WorkflowDefinition = {
  version: 1,
  id: 'cross-review',
  name: '交叉審查：Claude 實作，Codex 審查',
  description: '實作交給 Claude、審查交給 Codex，換一雙眼睛看。兩支 CLI 都要先登入。',
  params: [...DEFAULT_PARAMS],
  nodes: [
    { id: 'start', type: 'start', label: '開始', position: { x: 0, y: 0 } },
    {
      id: 'coder',
      type: 'agent',
      label: '實作',
      position: { x: 180, y: 0 },
      config: {
        kind: 'claude',
        prompt: '{{params.task}}',
        cwd: '{{params.cwd}}',
        permission: 'edit',
        role: 'coder',
      },
    },
    {
      id: 'reviewer',
      type: 'agent',
      label: '審查',
      position: { x: 360, y: 0 },
      config: {
        kind: 'codex',
        prompt:
          '審查目前工作目錄的變更有沒有完成「{{params.task}}」，最後一行只輸出 PASS 或 FAIL',
        cwd: '{{params.cwd}}',
        permission: 'readonly',
        role: 'reviewer',
      },
    },
    {
      id: 'check',
      type: 'condition',
      label: '審查過了嗎',
      position: { x: 540, y: 0 },
      config: { source: 'reviewer', rule: { type: 'lastLineEquals', value: 'PASS' } },
    },
    {
      id: 'approve',
      type: 'approval',
      label: '批准',
      position: { x: 720, y: 0 },
      config: { question: '要保留這次的變更嗎？' },
    },
    {
      id: 'coder-fix',
      type: 'agent',
      label: '修正',
      position: { x: 540, y: 160 },
      config: {
        kind: 'claude',
        prompt: '審查意見如下，請修正：\n{{reviewer.text}}',
        cwd: '{{params.cwd}}',
        permission: 'edit',
        role: 'coder',
        resumeFrom: 'coder',
        maxAttempts: 3,
      },
    },
    { id: 'end', type: 'end', label: '結束', position: { x: 900, y: 0 } },
  ],
  edges: [
    { from: 'start', to: 'coder' },
    { from: 'coder', to: 'reviewer', port: 'ok' },
    { from: 'reviewer', to: 'check', port: 'ok' },
    { from: 'check', to: 'approve', port: 'yes' },
    { from: 'check', to: 'coder-fix', port: 'no' },
    { from: 'coder-fix', to: 'reviewer', port: 'ok' },
    { from: 'approve', to: 'end', port: 'approved' },
  ],
};

export const TEMPLATES: readonly WorkflowDefinition[] = [
  IMPLEMENT_REVIEW_APPROVE,
  SOFTWARE_DEV,
  BUG_FIX,
  CODE_REVIEW,
  WRITE_TESTS,
  REFACTOR,
  PLAN_ONLY,
  CROSS_REVIEW,
];

export function templateInfos(): WorkflowInfo[] {
  return TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    params: paramsOf(template),
    builtin: true,
  }));
}

export function findTemplate(id: string): WorkflowDefinition | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
