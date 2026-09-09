import type { AgentEvent, AgentKind } from '../shared/agent';
import type { IAgentRun } from './agent-runner';
import { oneLine } from './agent-runner';
import type { IPtyProcess } from './pty';

const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/**
 * AgentRunPty — Adapter：把一次 agent 執行裝成 IPtyProcess 的樣子，
 * 這樣 SessionManager / IPC / renderer 完全不必知道 agent 這回事，
 * 一次執行在畫面上就是一個普通的工作階段。
 *
 * spike 的範圍：只有輸出方向。write / resize 是 no-op (沒有後續提示的介面)，
 * kill 則是取消整個執行。
 */
export class AgentRunPty implements IPtyProcess {
  private dataListener?: (data: string) => void;
  private exitListener?: (event: { exitCode: number }) => void;
  /** onData 還沒掛上時先存著；header 是在建構子就寫出來的。*/
  private buffered: string[] = [];

  constructor(
    private readonly run: IAgentRun,
    kind: AgentKind,
    prompt: string,
  ) {
    this.write_(`${DIM}[${kind}] 任務：${oneLine(prompt)}${RESET}`);
    this.run.onEvent((event) => this.render(event));
  }

  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
    for (const line of this.buffered) listener(line);
    this.buffered = [];
  }

  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exitListener = listener;
  }

  /** spike 沒有「追問」的介面，所以送進來的字直接丟掉。*/
  write(_data: string): void {}

  /** 沒有真的終端機可以改尺寸。*/
  resize(_cols: number, _rows: number): void {}

  kill(): void {
    this.run.cancel();
  }

  private render(event: AgentEvent): void {
    switch (event.type) {
      case 'init':
        return;

      case 'text':
        this.write_(event.text);
        return;

      case 'tool':
        this.write_(`${DIM}⚙ ${[event.name, event.summary].filter(Boolean).join(' ')}${RESET}`);
        return;

      case 'result':
        this.write_(footer(event));
        this.exitListener?.({ exitCode: event.exitCode });
        return;

      case 'error':
        this.write_(`${RED}✘ 失敗 · ${oneLine(event.message)}${RESET}`);
        this.exitListener?.({ exitCode: 1 });
        return;
    }
  }

  private write_(line: string): void {
    // 終端機吃的是 CRLF；CLI 給的多行文字只有 LF。
    const data = `${line.replace(/\n/g, '\r\n')}\r\n`;
    if (this.dataListener) this.dataListener(data);
    else this.buffered.push(data);
  }
}

function footer(event: Extract<AgentEvent, { type: 'result' }>): string {
  const parts: string[] = [];
  if (event.durationMs !== undefined) parts.push(`${(event.durationMs / 1000).toFixed(1)} s`);
  if (event.costUsd !== undefined) parts.push(`$${event.costUsd.toFixed(3)}`);
  if (event.sessionId) parts.push(`session ${event.sessionId.slice(0, 8)}…`);

  if (event.ok) return `${GREEN}${['✔ 完成', ...parts].join(' · ')}${RESET}`;
  const head = event.text ? `✘ 失敗：${oneLine(event.text)}` : '✘ 失敗';
  return `${RED}${[head, ...parts].join(' · ')}${RESET}`;
}
