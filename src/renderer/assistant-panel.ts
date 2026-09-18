import type { AppState } from './app-state';
import { renderAssistantText } from './assistant-text';
import type { AssistantPort } from './ports';
import type { AssistantEvent } from '../shared/assistant';
import { usageLabel, usageTitle } from '../shared/cli-auth';

export interface AssistantElements {
  panel: HTMLElement;
  messages: HTMLElement;
  /** 還沒問過任何問題時的那一塊 (說明 + 三顆建議)。*/
  empty: HTMLElement;
  /** 三顆建議：按下去把問題填進輸入框，送不送由人決定。*/
  chips: HTMLButtonElement[];
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  cancel: HTMLButtonElement;
  status: HTMLElement;
}

/**
 * AssistantPanel —— 右下角那一格的 DOM 殼，實作 AssistantPort。
 *
 * 跟其他檢視一樣訂閱 AppState 重畫 (Observer)，自己不決定任何行為：
 * 送出 / 新對話 / 取消都是 Command。答案是 main 推過來的事件，
 * 一段一段接在同一顆泡泡上；**模型的輸出只經過 renderAssistantText**
 * (跳脫後只認粗體、行內程式碼與清單)，沒有別的地方碰 innerHTML。
 */
export class AssistantPanel implements AssistantPort {
  /** 正在接答案的那顆泡泡；沒有在回答時是 null。*/
  private bubble: HTMLElement | null = null;
  /** 那顆泡泡目前累積的原文 —— 每來一段就整段重畫，清單才接得起來。*/
  private answer = '';

  constructor(
    private readonly el: AssistantElements,
    private readonly state: AppState,
    /** Enter 與「送出」是同一件事。*/
    send: () => void,
  ) {
    this.el.send.addEventListener('click', send);
    for (const chip of this.el.chips) {
      chip.addEventListener('click', () => {
        this.el.input.value = chip.textContent ?? '';
        this.el.input.focus();
      });
    }
    // Enter 送出、Shift+Enter 換行 (跟「輸入字」相反：那個框是拿來寫長訊息的)。
    this.el.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      send();
    });

    this.state.subscribe(() => this.render());
    this.render();
  }

  question(): string {
    return this.el.input.value;
  }

  start(question: string): void {
    this.el.input.value = '';
    this.el.empty.hidden = true;
    this.add('user').textContent = question;
    this.answer = '';
    this.bubble = this.add('bot');
    this.el.status.textContent = '回答中…';
    this.el.status.removeAttribute('title');
  }

  fail(message: string): void {
    this.finish(message);
  }

  clear(): void {
    for (const node of [...this.el.messages.children]) {
      if (node !== this.el.empty) node.remove();
    }
    this.el.empty.hidden = false;
    this.el.status.textContent = '';
    this.bubble = null;
    this.answer = '';
  }

  /** main 推過來的一個事件。*/
  handle(event: AssistantEvent): void {
    switch (event.type) {
      case 'delta':
        this.answer += event.text;
        if (this.bubble) this.bubble.innerHTML = renderAssistantText(this.answer);
        this.scroll();
        break;
      case 'done':
        this.bubble = null;
        this.el.status.textContent = this.usage(event.costUsd, event.durationMs);
        if (event.costUsd !== undefined) this.el.status.title = usageTitle(this.billingMode());
        break;
      case 'error':
        this.finish(event.message);
        break;
    }
  }

  /** 這一輪壞了：訊息寫在那顆還空著的泡泡裡，不然另外補一顆。*/
  private finish(message: string): void {
    const target = this.bubble && !this.answer ? this.bubble : this.add('bot');
    target.classList.add('error');
    target.textContent = message;
    this.bubble = null;
    this.el.status.textContent = '';
    this.scroll();
  }

  private add(kind: 'user' | 'bot'): HTMLElement {
    const el = document.createElement('div');
    el.className = `assistant-msg ${kind}`;
    this.el.messages.append(el);
    this.scroll();
    return el;
  }

  private scroll(): void {
    this.el.messages.scrollTop = this.el.messages.scrollHeight;
  }

  /** 「≈$0.012 · 4.2 s」；金額要不要標成估算跟別的地方一樣看 Claude 的登入方式。*/
  private usage(costUsd?: number, durationMs?: number): string {
    const parts: string[] = [];
    if (costUsd !== undefined) parts.push(usageLabel(costUsd, this.billingMode()));
    if (durationMs !== undefined) parts.push(`${(durationMs / 1000).toFixed(1)} s`);
    return parts.join(' · ');
  }

  private billingMode() {
    return this.state.cliAuth?.claude.mode ?? 'unknown';
  }

  private render(): void {
    const open = this.state.assistantOpen;
    // 剛打開的時候焦點進輸入框，打開就可以直接打字。
    if (this.el.panel.hidden === open) {
      this.el.panel.hidden = !open;
      if (open) this.el.input.focus();
    }
    const busy = this.state.assistantBusy;
    this.el.input.disabled = busy;
    this.el.send.disabled = busy;
    this.el.cancel.hidden = !busy;
  }
}
