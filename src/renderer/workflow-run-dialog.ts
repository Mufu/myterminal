import type { WorkflowInfo } from '../shared/workflow';
import { DEFAULT_MAX_TOTAL_COST_USD } from '../shared/workflow';
import type { BillingMode } from '../shared/cli-auth';
import type { DialogPort } from './ports';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`找不到元素 #${id}`);
  return el as T;
};

/**
 * 工作流的啟動參數驗證。工作目錄是必填的 ——
 * 這些 agent 真的會改檔案，不能讓它掉進家目錄。
 */
export function validateRunParams(params: { task: string; cwd: string }): string[] {
  const errors: string[] = [];
  if (!params.task.trim()) errors.push('請輸入任務內容');
  if (!params.cwd.trim()) errors.push('請輸入工作目錄');
  return errors;
}

/** 用量上限：留空 (或填了不是正數的東西) 就是不限制。*/
export function parseBudget(raw: string): number | undefined {
  const text = raw.trim();
  const value = Number(text);
  return text !== '' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** WorkflowRunDialog：跟 NewConnectionDialog 同一個寫法，對外只有 DialogPort.open()。*/
export class WorkflowRunDialog implements DialogPort {
  private readonly dialog = $<HTMLDialogElement>('workflow-run');
  private readonly workflow = $<HTMLSelectElement>('w-template');
  private readonly task = $<HTMLTextAreaElement>('w-task');
  private readonly cwd = $<HTMLInputElement>('w-cwd');
  private readonly budget = $<HTMLInputElement>('w-budget');
  private readonly errors = $<HTMLParagraphElement>('w-errors');
  private mode: BillingMode = 'unknown';

  constructor(
    private readonly onStart: (
      workflowId: string,
      params: Record<string, string>,
      maxTotalCostUsd?: number,
    ) => void,
  ) {
    $('w-ok').addEventListener('click', (event) => this.submit(event));
  }

  /** 內建範本與自訂工作流各自一個分組；沒有自訂的就不要那個空分組。*/
  setWorkflows(infos: WorkflowInfo[]): void {
    this.workflow.textContent = '';
    for (const [label, builtin] of [
      ['內建', true],
      ['自訂', false],
    ] as const) {
      const group = infos.filter((info) => info.builtin === builtin);
      if (group.length === 0) continue;
      const optgroup = document.createElement('optgroup');
      optgroup.label = label;
      for (const { id, name } of group) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = name;
        optgroup.appendChild(option);
      }
      this.workflow.appendChild(optgroup);
    }
  }

  /** CLI 的登入方式探測完才知道上限要不要先填一個數字。*/
  setBillingMode(mode: BillingMode): void {
    this.mode = mode;
  }

  /** 畫布的「儲存並執行」會指定要跑哪一個，其餘時候維持上一次的選擇。*/
  open(workflowId?: string): void {
    this.errors.textContent = '';
    // 只有 API 金鑰登入時這個上限才是真的在擋錢，訂閱帳號預設不限制。
    this.budget.value = this.mode === 'api' ? String(DEFAULT_MAX_TOTAL_COST_USD) : '';
    if (workflowId) this.workflow.value = workflowId;
    this.dialog.showModal();
    this.task.focus();
  }

  private submit(event: Event): void {
    const params = { task: this.task.value.trim(), cwd: this.cwd.value.trim() };
    const errors = validateRunParams(params);
    if (errors.length > 0) {
      // 阻止 <form method="dialog"> 關閉對話框，讓使用者修正。
      event.preventDefault();
      this.errors.textContent = errors.join('\n');
      return;
    }
    this.errors.textContent = '';
    this.onStart(this.workflow.value, params, parseBudget(this.budget.value));
  }
}
