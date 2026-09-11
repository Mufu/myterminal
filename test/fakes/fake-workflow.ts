import type { AgentEvent, AgentTask } from '../../src/shared/agent';
import type { IAgentRun, IAgentRunner } from '../../src/main/agent-runner';
import type { AdoptSpec } from '../../src/main/session-manager';
import type { IWorkflowSessions, Timers } from '../../src/main/workflow/graph-compiler';
import type { SessionInfo } from '../../src/shared/session';
import { FakeAgentRun } from './fake-agent';

/** 依照呼叫順序回答的 runner；回傳 null 代表這次永遠不回答 (測逾時／取消用)。*/
export class ScriptedRunner implements IAgentRunner {
  readonly tasks: AgentTask[] = [];
  readonly runs: FakeAgentRun[] = [];

  constructor(private readonly reply: (task: AgentTask, index: number) => AgentEvent | null) {}

  start(task: AgentTask): IAgentRun {
    const index = this.tasks.length;
    this.tasks.push(task);
    const run = new FakeAgentRun();
    this.runs.push(run);
    const event = this.reply(task, index);
    // 節點是同步跑到等結果那一步的，所以要等它掛好 listener 再發事件。
    if (event) queueMicrotask(() => run.emit(event));
    return run;
  }
}

export const agentResult = (
  over: Partial<Extract<AgentEvent, { type: 'result' }>> = {},
): AgentEvent => ({
  type: 'result',
  ok: true,
  text: 'ok',
  sessionId: 'cli-1',
  costUsd: 0.1,
  durationMs: 1000,
  exitCode: 0,
  ...over,
});

export class FakeSessions implements IWorkflowSessions {
  readonly adopted: AdoptSpec[] = [];
  private counter = 0;

  adoptAgentRun(_run: IAgentRun, spec: AdoptSpec): SessionInfo {
    this.adopted.push(spec);
    this.counter += 1;
    return {
      id: `s${this.counter}`,
      name: spec.name,
      type: 'agent',
      state: 'running',
      logging: false,
      cwd: spec.cwd,
      agentKind: spec.kind,
    };
  }
}

/** 手動觸發的計時器：記下每次要等多久，fireAll 才真的讓它逾時。*/
export class ManualTimers implements Timers {
  private readonly pending: Array<{ fn: () => void; ms: number } | undefined> = [];

  setTimeout(fn: () => void, ms: number): unknown {
    this.pending.push({ fn, ms });
    return this.pending.length;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.pending[handle - 1] = undefined;
  }

  get delays(): number[] {
    return this.pending.filter((t) => t !== undefined).map((t) => t.ms);
  }

  fireAll(): void {
    for (const [i, timer] of this.pending.entries()) {
      this.pending[i] = undefined;
      timer?.fn();
    }
  }
}

/** 等一個條件成立；用真的計時器輪詢，跟受測的注入計時器無關。*/
export async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!predicate()) throw new Error('等不到預期的狀態');
}
