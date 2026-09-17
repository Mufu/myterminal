const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`找不到元素 #${id}`);
  return el as T;
};

/** 上一次打的工作目錄；執行對話框與這個對話框共用一個。*/
export const LAST_CWD_KEY = 'myterminal.lastCwd';

export function rememberCwd(cwd: string): void {
  window.localStorage.setItem(LAST_CWD_KEY, cwd);
}

export function lastCwd(): string {
  return window.localStorage.getItem(LAST_CWD_KEY) ?? '';
}

/**
 * 節點的工作目錄代不出來 (例如 `{{params.cwd}}` 但這份工作流還沒跑過) 時問一次。
 * 跟其他對話框一樣只是 <dialog> 的殼：按確定才把目錄交出去，取消就什麼都不做。
 */
export class CwdPromptDialog {
  private readonly dialog = $<HTMLDialogElement>('cwd-prompt');
  private readonly input = $<HTMLInputElement>('cwd-input');
  private readonly errors = $<HTMLParagraphElement>('cwd-errors');
  private pending: ((cwd: string) => void) | null = null;

  constructor() {
    $('cwd-ok').addEventListener('click', (event) => this.submit(event));
    $('cwd-cancel').addEventListener('click', () => {
      this.pending = null;
    });
  }

  ask(onOk: (cwd: string) => void): void {
    this.pending = onOk;
    this.errors.textContent = '';
    this.input.value = lastCwd();
    this.dialog.showModal();
    this.input.focus();
    this.input.select();
  }

  /** 一律阻止 <form method="dialog"> 關掉對話框：沒填就要留在原地說一聲。*/
  private submit(event: Event): void {
    event.preventDefault();
    const cwd = this.input.value.trim();
    if (!cwd) {
      this.errors.textContent = '請輸入工作目錄';
      return;
    }
    const onOk = this.pending;
    this.pending = null;
    rememberCwd(cwd);
    this.dialog.close();
    onOk?.(cwd);
  }
}
