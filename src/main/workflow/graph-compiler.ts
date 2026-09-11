import { homedir } from 'node:os';
import { Annotation, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type {
  ConditionRule,
  RunNodeStatus,
  WorkflowDefinition,
  WorkflowNode,
} from '../../shared/workflow';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_SEC,
  validateWorkflow,
} from '../../shared/workflow';
import type { AdoptSpec } from '../session-manager';
import type { IAgentRun, IAgentRunnerFactory } from '../agent-runner';
import type { SessionInfo } from '../../shared/session';

/**
 * GraphCompiler：把一份 WorkflowDefinition 編譯成真的 LangGraph StateGraph。
 * 這裡沒有自己的排程器 —— 節點之間怎麼走、狀態怎麼合併、中斷之後怎麼接回去，
 * 全部是 LangGraph 的工作，本檔案只負責「定義 -> 圖」這層轉換。
 */

/** 一個節點跑完之後留在狀態裡的東西。sessionId 是 CLI 的，resumeFrom 要用。*/
export interface NodeOutput {
  text: string;
  sessionId?: string;
  ok: boolean;
  costUsd?: number;
  durationMs?: number;
}

const merge = <T>(left: Record<string, T>, right: Record<string, T>): Record<string, T> => ({
  ...left,
  ...right,
});

export const RunAnnotation = Annotation.Root({
  outputs: Annotation<Record<string, NodeOutput>>({ reducer: merge, default: () => ({}) }),
  attempts: Annotation<Record<string, number>>({ reducer: merge, default: () => ({}) }),
  lastPort: Annotation<Record<string, string>>({ reducer: merge, default: () => ({}) }),
  totalCostUsd: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
});

export type RunGraphState = typeof RunAnnotation.State;

/** 內部出口：沒有任何連線對應得上，router 一律送到 END。*/
const ABORT = '__abort__';

/** approval 節點恢復執行時收到的值 (一定要是物件，見下面 interrupt 那段的註解)。*/
export interface ApprovalAnswer {
  approved: boolean;
}

/** SessionManager 在這裡的樣子：編排層只需要「把執行變成工作階段」這一件事。*/
export interface IWorkflowSessions {
  adoptAgentRun(run: IAgentRun, spec: AdoptSpec): SessionInfo;
}

/** 逾時用的計時器縫線，測試注入假的才不用真的等十分鐘。*/
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 節點進度回報。圖的狀態要等超步結束才看得到，但畫面要馬上知道
 * 「哪個節點在跑、開了哪個工作階段」，所以編排層直接回報。
 */
export type NodeReport = (event: {
  nodeId: string;
  status: RunNodeStatus;
  sessionId?: string;
  costUsd?: number;
  attempts?: number;
}) => void;

export interface CompileDeps {
  runnerFactory: IAgentRunnerFactory;
  sessions: IWorkflowSessions;
  checkpointer: BaseCheckpointSaver;
  budget: { maxTotalCostUsd: number };
  /** 啟動參數，樣板裡用 {{params.x}} 取用。*/
  params: Record<string, string>;
  report?: NodeReport;
  timers?: Timers;
}

/** invoke 的回傳：狀態再加上 LangGraph 中斷時塞進來的那個 key。*/
export type RunResult = RunGraphState & {
  __interrupt__?: Array<{ value?: { question?: string } }>;
};

export interface WorkflowApp {
  invoke(
    input: unknown,
    options: { configurable: { thread_id: string }; recursionLimit: number },
  ): Promise<RunResult>;
}

export interface CompiledWorkflow {
  app: WorkflowApp;
  /** 取消：砍掉正在跑的 CLI，之後輪到的節點一律直接收尾。*/
  cancel(): void;
}

/**
 * 節點名稱是執行時才知道的，LangGraph 的 builder 型別卻是靠 addNode 的回傳值
 * 一層層累積上去的。這裡放掉那層型別（節點函式本身仍然是 RunGraphState 進出）。
 */
type NodeAction = (state: RunGraphState) => Partial<RunGraphState> | Promise<Partial<RunGraphState>>;
interface Builder {
  addNode(key: string, action: NodeAction): Builder;
  addEdge(from: string, to: string): Builder;
  addConditionalEdges(
    from: string,
    router: (state: RunGraphState) => string,
    pathMap: string[],
  ): Builder;
  compile(options: { checkpointer: BaseCheckpointSaver }): WorkflowApp;
}

/** 取消旗標與目前正在跑的執行，compile 出來的每個節點共用同一個。*/
interface Control {
  cancelled: boolean;
  active?: IAgentRun;
}

export function compile(def: WorkflowDefinition, deps: CompileDeps): CompiledWorkflow {
  const errors = validateWorkflow(def);
  if (errors.length > 0) throw new Error(`工作流定義不合法：${errors.join('、')}`);

  const control: Control = { cancelled: false };
  const graph = new StateGraph(RunAnnotation) as unknown as Builder;

  for (const node of def.nodes) graph.addNode(node.id, action(node, def, deps, control));

  for (const node of def.nodes) {
    if (node.type === 'start') {
      graph.addEdge(START, node.id);
      const next = def.edges.find((edge) => edge.from === node.id);
      graph.addEdge(node.id, next?.to ?? END);
      continue;
    }
    if (node.type === 'end') {
      graph.addEdge(node.id, END);
      continue;
    }
    // 有出口的節點：router 只看 lastPort，對不上的出口 (含 ABORT) 就收尾。
    const targets: Record<string, string> = {};
    for (const edge of def.edges) {
      if (edge.from === node.id && edge.port) targets[edge.port] = edge.to;
    }
    const paths = [...new Set([...Object.values(targets), END])];
    graph.addConditionalEdges(node.id, (state) => targets[state.lastPort[node.id]] ?? END, paths);
  }

  return {
    app: graph.compile({ checkpointer: deps.checkpointer }),
    cancel: () => {
      control.cancelled = true;
      control.active?.cancel();
    },
  };
}

function action(
  node: WorkflowNode,
  def: WorkflowDefinition,
  deps: CompileDeps,
  control: Control,
): NodeAction {
  switch (node.type) {
    case 'start':
    case 'end':
      return () => {
        deps.report?.({ nodeId: node.id, status: 'done' });
        // end 節點留下記號，這樣「有沒有真的走到結束」是狀態裡看得到的事。
        return node.type === 'end' ? { lastPort: { [node.id]: 'done' } } : {};
      };

    case 'condition':
      return (state) => {
        if (control.cancelled) return abort(node.id);
        const text = state.outputs[node.config.source]?.text ?? '';
        deps.report?.({ nodeId: node.id, status: 'done' });
        return { lastPort: { [node.id]: matches(node.config.rule, text) ? 'yes' : 'no' } };
      };

    case 'approval':
      return () => {
        if (control.cancelled) return abort(node.id);
        deps.report?.({ nodeId: node.id, status: 'waiting' });
        // interrupt 會丟出 GraphInterrupt 讓整張圖停在這裡，
        // 之後用 Command({ resume }) 回來時它才會回傳那個值。
        // 回來的值包成物件是必要的：LangGraph 的 mapCommand 用 `if (cmd.resume)`
        // 判斷，直接傳 false 會被當成空的輸入而丟 EmptyInputError。
        const answer = interrupt<{ question: string }, ApprovalAnswer>({
          question: node.config.question,
        });
        deps.report?.({ nodeId: node.id, status: 'done' });
        return { lastPort: { [node.id]: answer.approved ? 'approved' : 'rejected' } };
      };

    case 'agent':
      return (state) => runAgent(node, node.config, def, deps, control, state);
  }
}

/** 取消之後輪到的節點：什麼都不做，走一個沒有連線的出口讓 router 收尾。*/
function abort(id: string): Partial<RunGraphState> {
  return { lastPort: { [id]: ABORT } };
}

async function runAgent(
  node: WorkflowNode,
  config: Extract<WorkflowNode, { type: 'agent' }>['config'],
  def: WorkflowDefinition,
  deps: CompileDeps,
  control: Control,
  state: RunGraphState,
): Promise<Partial<RunGraphState>> {
  if (control.cancelled) return abort(node.id);

  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const attempts = (state.attempts[node.id] ?? 0) + 1;
  if (attempts > maxAttempts) {
    deps.report?.({ nodeId: node.id, status: 'failed' });
    return {
      outputs: { [node.id]: { text: `重試 ${maxAttempts} 次仍未通過`, ok: false } },
      lastPort: { [node.id]: ABORT },
    };
  }

  const prompt = render(config.prompt, state, deps.params);
  const cwd = render(config.cwd ?? '', state, deps.params).trim() || homedir();
  deps.report?.({ nodeId: node.id, status: 'running', attempts });

  const run = deps.runnerFactory(config.kind).start({
    kind: config.kind,
    prompt,
    cwd,
    allowEdits: config.allowEdits,
    resumeId: config.resumeFrom ? state.outputs[config.resumeFrom]?.sessionId : undefined,
  });
  control.active = run;

  // 這一次執行在畫面上就是一個普通的工作階段，可以切過去看、也可以接手。
  const session = deps.sessions.adoptAgentRun(run, {
    name: `${def.name} · ${node.label}`,
    kind: config.kind,
    prompt,
    cwd,
  });
  deps.report?.({ nodeId: node.id, status: 'running', sessionId: session.id, attempts });

  const timeoutSec = config.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const outcome = await waitForResult(run, timeoutSec, deps.timers ?? realTimers);
  control.active = undefined;

  const cost = outcome.costUsd ?? 0;
  const overBudget = state.totalCostUsd + cost > deps.budget.maxTotalCostUsd;
  const ok = outcome.ok && !overBudget;
  deps.report?.({
    nodeId: node.id,
    status: ok ? 'done' : 'failed',
    sessionId: session.id,
    costUsd: outcome.costUsd,
    attempts,
  });

  return {
    outputs: {
      [node.id]: {
        text: overBudget ? `超出這次執行的預算上限 $${deps.budget.maxTotalCostUsd}` : outcome.text,
        sessionId: outcome.sessionId,
        ok,
        costUsd: outcome.costUsd,
        durationMs: outcome.durationMs,
      },
    },
    attempts: { [node.id]: attempts },
    lastPort: { [node.id]: overBudget ? ABORT : ok ? 'ok' : 'fail' },
    totalCostUsd: cost,
  };
}

interface Outcome {
  ok: boolean;
  text: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
}

/** 等 CLI 回報結果；超時就取消執行並當成失敗。*/
function waitForResult(run: IAgentRun, timeoutSec: number, timers: Timers): Promise<Outcome> {
  return new Promise((resolve) => {
    let settled = false;
    let handle: unknown;
    const finish = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(handle);
      resolve(outcome);
    };
    handle = timers.setTimeout(() => {
      if (settled) return;
      run.cancel();
      finish({ ok: false, text: `超過 ${timeoutSec} 秒還沒有結果` });
    }, timeoutSec * 1000);

    run.onEvent((event) => {
      if (event.type === 'result') {
        finish({
          ok: event.ok,
          text: event.text,
          sessionId: event.sessionId,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
        });
      } else if (event.type === 'error') {
        finish({ ok: false, text: event.message });
      }
    });
  });
}

/** 提示樣板：{{節點id.text}} 代入上游輸出，{{params.x}} 代入啟動參數。*/
export function render(
  template: string,
  state: RunGraphState,
  params: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([^.\s{}]+)\.([^.\s{}]+)\s*\}\}/g, (whole, head, field) => {
    if (head === 'params') return params[field] ?? '';
    if (field === 'text') return state.outputs[head]?.text ?? '';
    return whole;
  });
}

export function matches(rule: ConditionRule, text: string): boolean {
  if (rule.type === 'regex') return new RegExp(rule.pattern).test(text);
  const lines = text.trimEnd().split('\n');
  return (lines.at(-1) ?? '').trim() === rule.value;
}

/**
 * 這次執行算不算成功：有走到 end 節點就是成功，
 * 其他情況 (退回、節點失敗、重試用完、超出預算、取消) 都要給一句原因。
 */
export function runOutcome(
  def: WorkflowDefinition,
  state: RunGraphState,
): { ok: boolean; error?: string } {
  if (def.nodes.some((node) => node.type === 'end' && state.lastPort[node.id] !== undefined)) {
    return { ok: true };
  }
  const rejected = def.nodes.find(
    (node) => node.type === 'approval' && state.lastPort[node.id] === 'rejected',
  );
  if (rejected) return { ok: false, error: `${rejected.label}：已退回` };

  const failed = def.nodes.filter((node) => state.outputs[node.id]?.ok === false).at(-1);
  if (failed) return { ok: false, error: `${failed.label}：${state.outputs[failed.id].text}` };
  return { ok: false, error: '工作流沒有走到結束節點' };
}
