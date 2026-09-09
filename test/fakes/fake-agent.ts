import type { AgentEvent, AgentTask } from '../../src/shared/agent';
import type { IAgentRun, IAgentRunner } from '../../src/main/agent-runner';

/** 測試替身：手動發出事件的一次 agent 執行。*/
export class FakeAgentRun implements IAgentRun {
  cancelled = false;
  private readonly listeners: Array<(event: AgentEvent) => void> = [];

  onEvent(listener: (event: AgentEvent) => void): void {
    this.listeners.push(listener);
  }

  cancel(): void {
    this.cancelled = true;
  }

  emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

export class FakeAgentRunner implements IAgentRunner {
  readonly tasks: AgentTask[] = [];
  readonly runs: FakeAgentRun[] = [];

  start(task: AgentTask): IAgentRun {
    this.tasks.push(task);
    const run = new FakeAgentRun();
    this.runs.push(run);
    return run;
  }

  last(): FakeAgentRun {
    const run = this.runs.at(-1);
    if (!run) throw new Error('還沒有開始任何 agent 執行');
    return run;
  }
}
