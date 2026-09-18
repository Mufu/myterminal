import { homedir } from 'node:os';
import type { AssistantEvent } from '../shared/assistant';
import { ASSISTANT_MODEL } from '../shared/assistant';
import { JsonlRun, claudeEvents } from './agent-runner';
import type { IProcessSpawner } from './process-spawner';

export interface AssistantOptions {
  /** 助理的知識檔 (docs/ASSISTANT.md)；打包版在 resources 底下。*/
  knowledgePath: string;
  /** 沒登入就不必開行程 —— claude 只會回一句英文的錯誤。*/
  isClaudeLoggedIn: () => boolean;
  /** 預設 sonnet；助理只是查手冊，不需要更貴的型號。*/
  model?: string;
}

/**
 * AssistantService —— 「助理」那一格背後的東西。
 *
 * 跟 Agent 任務走同一支 `claude -p --output-format stream-json --verbose`，
 * 但刻意只給它「回答」這一件事：`--tools ""` 關掉所有工具，知識檔以
 * `--append-system-prompt-file` 疊在系統提示上。所以它改不了檔案、跑不了指令，
 * 問題與畫面狀態走 stdin，不碰命令列引號。
 *
 * 同一時間只跑一個 (單飛)，而且記著上一次的 session id，第二個問題就是接續同一段對話。
 */
export class AssistantService {
  /** 上一次的 CLI 對話；有的話下一個問題就 --resume 回去。*/
  private sessionId?: string;
  /** 正在回答的那一次；沒有在回答時是 undefined。*/
  private run?: JsonlRun;

  constructor(
    private readonly spawner: IProcessSpawner,
    private readonly opts: AssistantOptions,
  ) {}

  /** 問一句。行程結束才 resolve；答案與失敗都以事件送出去。*/
  ask(question: string, context: string, onEvent: (event: AssistantEvent) => void): Promise<void> {
    if (this.run) return Promise.reject(new Error('上一個問題還在回答中'));
    if (!this.opts.isClaudeLoggedIn()) {
      return Promise.reject(new Error('Claude 尚未登入，請先在「CLI 設定」登入'));
    }

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      this.opts.model ?? ASSISTANT_MODEL,
      // 只回答，不做事：空字串就是關掉全部內建工具。
      '--tools',
      '',
      '--append-system-prompt-file',
      this.opts.knowledgePath,
    ];
    if (this.sessionId) args.push('--resume', this.sessionId);

    return new Promise<void>((resolve) => {
      /** 已經送出過答案的文字了；沒有的話就用 result 裡那一份。*/
      let answered = false;
      const finish = (): void => {
        this.run = undefined;
        resolve();
      };

      const run = new JsonlRun(
        this.spawner,
        {
          file: 'claude',
          args,
          cwd: homedir(),
          stdin: `${context}\n\n${question}`,
        },
        claudeEvents,
      );
      this.run = run;

      run.onEvent((event) => {
        switch (event.type) {
          case 'init':
            this.sessionId = event.sessionId;
            break;
          case 'text':
            answered = true;
            onEvent({ type: 'delta', text: event.text });
            break;
          case 'result':
            if (event.sessionId) this.sessionId = event.sessionId;
            if (!event.ok) onEvent({ type: 'error', message: event.text || 'Claude 沒有回答' });
            else {
              // 沒有 assistant 訊息時答案只在 result 裡。
              if (!answered && event.text) onEvent({ type: 'delta', text: event.text });
              onEvent({
                type: 'done',
                sessionId: event.sessionId,
                costUsd: event.costUsd,
                durationMs: event.durationMs,
              });
            }
            finish();
            break;
          case 'error':
            onEvent({ type: 'error', message: event.message });
            finish();
            break;
          case 'tool':
            // --tools "" 之下不會有工具，真的出現也不必顯示。
            break;
        }
      });
    });
  }

  /** 「新對話」：忘掉上一段，下一個問題重新開始。*/
  reset(): void {
    this.sessionId = undefined;
  }

  /** 回答到一半按「取消」：砍掉行程，事件會是「已取消」。*/
  cancel(): void {
    this.run?.cancel();
  }
}
