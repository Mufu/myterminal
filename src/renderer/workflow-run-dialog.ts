import type { WorkflowTemplateInfo } from '../shared/workflow';
import type { DialogPort } from './ports';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`找不到元素 #${id}`);
  return el as T;
};

/**
 * 範本的啟動參數驗證。工作目錄是必填的 ——
 * 這個範本的 agent 真的會改檔案，不能讓它掉進家目錄。
 */
export function validateRunParams(params: { task: string; cwd: string }): string[] {
  const errors: string[] = [];
  if (!params.task.trim()) errors.push('請輸入任務內容');
  if (!params.cwd.trim()) errors.push('請輸入工作目錄');
  return errors;
}

/** WorkflowRunDialog：跟 NewConnectionDialog 同一個寫法，對外只有 DialogPort.open()。*/
export class WorkflowRunDialog implements DialogPort {
  private readonly dialog = $<HTMLDialogElement>('workflow-run');
  private readonly template = $<HTMLSelectElement>('w-template');
  private readonly task = $<HTMLTextAreaElement>('w-task');
  private readonly cwd = $<HTMLInputElement>('w-cwd');
  private readonly errors = $<HTMLParagraphElement>('w-errors');

  constructor(
    private readonly onStart: (templateId: string, params: Record<string, string>) => void,
  ) {
    $('w-ok').addEventListener('click', (event) => this.submit(event));
  }

  setTemplates(templates: WorkflowTemplateInfo[]): void {
    this.template.textContent = '';
    for (const { id, name } of templates) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = name;
      this.template.appendChild(option);
    }
  }

  open(): void {
    this.errors.textContent = '';
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
    this.onStart(this.template.value, params);
  }
}
