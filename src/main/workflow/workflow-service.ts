import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { RunState, RunStatus, WorkflowDefinition } from '../../shared/workflow';
import { DEFAULT_MAX_TOTAL_COST_USD } from '../../shared/workflow';
import type { IAgentRunnerFactory } from '../agent-runner';
import type { CompiledWorkflow, IWorkflowSessions, NodeReport, Timers } from './graph-compiler';
import { compile, runOutcome } from './graph-compiler';

/** 讀／寫執行清單摘要的縫線，跟 ProfileStore 同一個手法。*/
export type RunsReader = () => string | null;
export type RunsWriter = (content: string) => void;

/**
 * 存進 workflow-runs.json 的一筆。定義與參數要一起存，
 * 不然 app 重開之後沒辦法把圖重新編譯出來接續執行。
 */
interface StoredRun {
  state: RunState;
  definition: WorkflowDefinition;
  params: Record<string, string>;
}

export interface WorkflowServiceDeps {
  runnerFactory: IAgentRunnerFactory;
  sessions: IWorkflowSessions;
  checkpointer: BaseCheckpointSaver;
  read: RunsReader;
  write: RunsWriter;
  maxTotalCostUsd?: number;
  timers?: Timers;
  now?: () => number;
  newRunId?: () => string;
}

type WorkflowEvents = { changed: [RunState[]] };

/**
 * 迴圈 (審查 → 修正 → 審查) 一步算一個超步，maxAttempts 已經擋住無限繞，
 * 這個上限只是最後一道保險。
 */
const RECURSION_LIMIT = 100;

const TERMINAL: readonly RunStatus[] = ['done', 'failed', 'cancelled'];

/**
 * WorkflowService — Observer，跟 SessionManager 同一個寫法。
 * 它不做排程：start / resume 就是把輸入丟進 LangGraph 的 invoke，
 * 中斷、接續、狀態合併全部是圖那邊的事。這裡負責的是「一次執行」這個殼：
 * 狀態摘要、費用、持久化，以及把節點進度推給 renderer。
 */
export class WorkflowService extends EventEmitter<WorkflowEvents> {
  private readonly runs = new Map<string, StoredRun>();
  /** 還在跑 (或等批准) 的執行才需要留著編譯好的圖。*/
  private readonly graphs = new Map<string, CompiledWorkflow>();

  constructor(private readonly deps: WorkflowServiceDeps) {
    super();
    for (const stored of this.restore()) this.runs.set(stored.state.runId, stored);
  }

  list(): RunState[] {
    return [...this.runs.values()].map((stored) => structuredClone(stored.state));
  }

  start(definition: WorkflowDefinition, params: Record<string, string>): string {
    const runId = (this.deps.newRunId ?? randomUUID)();
    const stored: StoredRun = {
      definition,
      params,
      state: {
        runId,
        workflowId: definition.id,
        name: definition.name,
        status: 'running',
        nodes: Object.fromEntries(
          definition.nodes.map((node) => [node.id, { status: 'idle' as const, attempts: 0 }]),
        ),
        totalCostUsd: 0,
        startedAt: this.now(),
      },
    };
    this.runs.set(runId, stored);
    this.changed();
    void this.drive(stored, {});
    return runId;
  }

  /** 批准或退回：LangGraph 那邊就是帶著 resume 值再 invoke 一次。*/
  resume(runId: string, answer: { approved: boolean }): void {
    const stored = this.runs.get(runId);
    if (!stored || stored.state.status !== 'waiting_approval') return;
    stored.state.status = 'running';
    stored.state.question = undefined;
    this.changed();
    void this.drive(stored, new Command({ resume: { approved: answer.approved } }));
  }

  cancel(runId: string): void {
    const stored = this.runs.get(runId);
    if (!stored) return;
    this.graphs.get(runId)?.cancel();
    this.settle(stored, 'cancelled');
  }

  private async drive(stored: StoredRun, input: unknown): Promise<void> {
    try {
      const result = await this.graph(stored).app.invoke(input, {
        configurable: { thread_id: stored.state.runId },
        recursionLimit: RECURSION_LIMIT,
      });

      const question = result.__interrupt__?.[0]?.value?.question;
      if (question !== undefined) {
        if (this.done(stored)) return;
        stored.state.status = 'waiting_approval';
        stored.state.question = question;
        this.changed();
        return;
      }

      const outcome = runOutcome(stored.definition, result);
      this.settle(stored, outcome.ok ? 'done' : 'failed', outcome.error);
    } catch (error) {
      this.settle(stored, 'failed', String(error));
    }
  }

  /** 已經收尾的執行 (例如中途被取消) 不要再被 invoke 的結果覆寫。*/
  private done(stored: StoredRun): boolean {
    return TERMINAL.includes(stored.state.status);
  }

  private settle(stored: StoredRun, status: RunStatus, error?: string): void {
    if (this.done(stored)) return;
    stored.state.status = status;
    stored.state.finishedAt = this.now();
    stored.state.question = undefined;
    if (error) stored.state.error = error;
    for (const node of Object.values(stored.state.nodes)) {
      // 沒輪到的節點是「略過」，正在跑的那個隨著執行一起收掉。
      if (node.status === 'idle') node.status = 'skipped';
      else if (node.status === 'running' || node.status === 'waiting') node.status = 'failed';
    }
    this.graphs.delete(stored.state.runId);
    this.changed();
  }

  private graph(stored: StoredRun): CompiledWorkflow {
    const existing = this.graphs.get(stored.state.runId);
    if (existing) return existing;
    const compiled = compile(stored.definition, {
      runnerFactory: this.deps.runnerFactory,
      sessions: this.deps.sessions,
      checkpointer: this.deps.checkpointer,
      budget: { maxTotalCostUsd: this.deps.maxTotalCostUsd ?? DEFAULT_MAX_TOTAL_COST_USD },
      params: stored.params,
      timers: this.deps.timers,
      report: (event) => this.report(stored, event),
    });
    this.graphs.set(stored.state.runId, compiled);
    return compiled;
  }

  /** 編排層回報的節點進度，直接變成畫面上那一列。*/
  private report(stored: StoredRun, event: Parameters<NodeReport>[0]): void {
    const node = stored.state.nodes[event.nodeId];
    if (!node) return;
    node.status = event.status;
    if (event.sessionId) node.sessionId = event.sessionId;
    if (event.attempts !== undefined) node.attempts = event.attempts;
    if (event.costUsd !== undefined) {
      node.costUsd = (node.costUsd ?? 0) + event.costUsd;
      stored.state.totalCostUsd += event.costUsd;
    }
    this.changed();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private changed(): void {
    this.deps.write(`${JSON.stringify([...this.runs.values()], null, 2)}\n`);
    this.emit('changed', this.list());
  }

  /**
   * 開機時把上次的執行讀回來。「等待批准」的可以直接接下去
   * (checkpointer 裡有完整的圖狀態)，但「執行中」的接不回去 —— CLI 行程已經不在了。
   */
  private restore(): StoredRun[] {
    const raw = this.deps.read();
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isStoredRun).map((stored) => {
      if (stored.state.status !== 'running') return stored;
      stored.state.status = 'failed';
      stored.state.error = 'app 在執行途中關閉了';
      stored.state.finishedAt = this.now();
      for (const node of Object.values(stored.state.nodes)) {
        if (node.status === 'running') node.status = 'failed';
        else if (node.status === 'idle') node.status = 'skipped';
      }
      return stored;
    });
  }
}

/** 手動編輯過的 JSON 也可能少欄位，缺 runId 或定義的那一筆直接忽略。*/
function isStoredRun(value: unknown): value is StoredRun {
  if (typeof value !== 'object' || value === null) return false;
  const { state, definition } = value as Partial<StoredRun>;
  return (
    typeof state?.runId === 'string' &&
    typeof state.nodes === 'object' &&
    Array.isArray(definition?.nodes)
  );
}

/** 正式環境：整份清單一次讀進來、一次覆寫回去。*/
export function fileRunStore(path: string): { read: RunsReader; write: RunsWriter } {
  return {
    read: () => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    write: (content) => writeFileSync(path, content, 'utf8'),
  };
}
