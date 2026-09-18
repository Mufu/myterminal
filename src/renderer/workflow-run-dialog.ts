import type { WorkflowInfo, WorkflowParamDef } from '../shared/workflow';
import { DEFAULT_MAX_TOTAL_COST_USD, DEFAULT_PARAMS, validateRunParams } from '../shared/workflow';
import type { BillingMode } from '../shared/cli-auth';
import type { DialogPort } from './ports';
import { lastCwd, rememberCwd } from './cwd-prompt-dialog';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`找不到元素 #${id}`);
  return el as T;
};

/** 用量上限：留空 (或填了不是正數的東西) 就是不限制。*/
export function parseBudget(raw: string): number | undefined {
  const text = raw.trim();
  const value = Number(text);
  return text !== '' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 參數欄位的 id：task 與 cwd 是一直以來的那兩個 (e2e 與手冊都指名它們)，
 * 自己加的參數就是 `w-param-<名稱>`。
 */
export function fieldId(name: string): string {
  return name === 'task' || name === 'cwd' ? `w-${name}` : `w-param-${name}`;
}

/** 目錄參數上一次填的值放哪；cwd 跟「手動操作」的工作目錄對話框共用同一個。*/
function remember(name: string, value: string): void {
  if (name === 'cwd') rememberCwd(value);
  else window.localStorage.setItem(`myterminal.lastParam.${name}`, value);
}

function recall(name: string): string {
  if (name === 'cwd') return lastCwd();
  return window.localStorage.getItem(`myterminal.lastParam.${name}`) ?? '';
}

/** WorkflowRunDialog：跟 NewConnectionDialog 同一個寫法，對外只有 DialogPort.open()。*/
export class WorkflowRunDialog implements DialogPort {
  private readonly dialog = $<HTMLDialogElement>('workflow-run');
  private readonly workflow = $<HTMLSelectElement>('w-template');
  private readonly description = $<HTMLParagraphElement>('w-description');
  private readonly fields = $<HTMLDivElement>('w-params');
  private readonly budget = $<HTMLInputElement>('w-budget');
  private readonly errors = $<HTMLParagraphElement>('w-errors');
  private mode: BillingMode = 'unknown';
  private infos: WorkflowInfo[] = [];
  private params: readonly WorkflowParamDef[] = DEFAULT_PARAMS;
  /** 欄位現在長的是哪一組參數：同一組就不重建，不然打到一半會被換掉。*/
  private fieldsKey = '';
  private inputs = new Map<string, HTMLTextAreaElement | HTMLInputElement>();

  constructor(
    private readonly onStart: (
      workflowId: string,
      params: Record<string, string>,
      maxTotalCostUsd?: number,
    ) => void | Promise<void>,
  ) {
    $('w-ok').addEventListener('click', (event) => this.submit(event));
    this.workflow.addEventListener('change', () => this.showWorkflow());
    this.renderFields();
  }

  /** 內建範本與自訂工作流各自一個分組；沒有自訂的就不要那個空分組。*/
  setWorkflows(infos: WorkflowInfo[]): void {
    this.infos = infos;
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
    this.showWorkflow();
  }

  /** 選中的那一個的說明與欄位；沒有說明的工作流就留白。*/
  private showWorkflow(): void {
    const info = this.infos.find((i) => i.id === this.workflow.value);
    this.description.textContent = info?.description ?? '';
    this.params = info?.params ?? DEFAULT_PARAMS;
    this.renderFields();
  }

  /** 欄位照著這份工作流宣告的參數長出來。*/
  private renderFields(): void {
    const key = JSON.stringify(this.params);
    if (key === this.fieldsKey) return;
    this.fieldsKey = key;
    this.fields.textContent = '';
    this.inputs.clear();

    for (const param of this.params) {
      const label = document.createElement('label');
      label.append(param.label);
      const field =
        param.kind === 'multiline'
          ? document.createElement('textarea')
          : document.createElement('input');
      if (field instanceof HTMLTextAreaElement) field.rows = 4;
      else field.type = 'text';
      field.id = fieldId(param.name);
      if (param.hint) field.placeholder = param.hint;
      // 目錄記得上一次填的，其餘用宣告的預設值。
      field.value = param.default ?? (param.kind === 'directory' ? recall(param.name) : '');
      label.appendChild(field);
      this.fields.appendChild(label);
      this.inputs.set(param.name, field);
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
    this.showWorkflow();
    this.dialog.showModal();
    this.inputs.values().next().value?.focus();
  }

  private submit(event: Event): void {
    // 一律阻止 <form method="dialog"> 關閉對話框：main 也可能拒絕
    // (例如工作目錄不存在)，那時要留在原地把原因顯示出來。
    event.preventDefault();
    const params: Record<string, string> = {};
    for (const [name, field] of this.inputs) params[name] = field.value.trim();

    const errors = validateRunParams({ params: this.params }, params);
    if (errors.length > 0) {
      this.errors.textContent = errors.join('\n');
      return;
    }
    this.errors.textContent = '';
    // 畫布上手動開終端機時要問工作目錄，預設就填這一個。
    for (const param of this.params) {
      if (param.kind === 'directory') remember(param.name, params[param.name]);
    }
    void this.start(params);
  }

  /** main 收下了才關對話框；被拒絕就把訊息留在上面。*/
  private async start(params: Record<string, string>): Promise<void> {
    try {
      await this.onStart(this.workflow.value, params, parseBudget(this.budget.value));
    } catch (error) {
      this.errors.textContent = error instanceof Error ? error.message : String(error);
      return;
    }
    this.dialog.close();
  }
}
