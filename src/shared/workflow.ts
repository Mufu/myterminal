import type { AgentKind, AgentPermission } from './agent';
import { isAgentPermission } from './agent';
import type { BaseShell } from './profile';
import type { AgentRole } from './roles';
import { findRole } from './roles';

/**
 * 工作流定義 (version 1)：純 JSON，是唯一的真相來源 ——
 * 編排層 (GraphCompiler) 與畫布編輯器都只看這一份。
 * `position` 是畫布上的座標，執行那一側不看它。
 */

export type WorkflowNodeType = 'start' | 'end' | 'agent' | 'condition' | 'approval';

/** 節點的出口。agent 是 ok/fail、condition 是 yes/no、approval 是 approved/rejected。*/
export type WorkflowPort = 'ok' | 'fail' | 'yes' | 'no' | 'approved' | 'rejected';

export const NODE_PORTS: Record<WorkflowNodeType, readonly WorkflowPort[]> = {
  start: [],
  end: [],
  agent: ['ok', 'fail'],
  condition: ['yes', 'no'],
  approval: ['approved', 'rejected'],
};

export interface NodePosition {
  x: number;
  y: number;
}

export interface AgentNodeConfig {
  kind: AgentKind;
  /** 提示樣板：`{{<nodeId>.text}}` 代入上游節點的輸出，`{{params.x}}` 代入啟動參數。*/
  prompt: string;
  cwd?: string;
  /** 給 CLI 多少權限；沒寫就是最保守的唯讀。*/
  permission?: AgentPermission;
  /** 畫布上的「手動操作」要在哪個終端機裡開；執行那一側不看它。*/
  shell?: BaseShell;
  /** 角色：前置指示在 shared/roles.ts，這裡只存 id。*/
  role?: AgentRole;
  /** 要接續哪個節點的 CLI 對話 (claude --resume <session_id>)。*/
  resumeFrom?: string;
  maxAttempts?: number;
  timeoutSec?: number;
}

export type ConditionRule =
  | { type: 'lastLineEquals'; value: string }
  | { type: 'regex'; pattern: string };

export interface ConditionNodeConfig {
  /** 要判斷哪個節點的輸出。*/
  source: string;
  rule: ConditionRule;
}

export interface ApprovalNodeConfig {
  question: string;
}

interface NodeBase {
  id: string;
  label: string;
  position: NodePosition;
}

export type WorkflowNode =
  | (NodeBase & { type: 'start' })
  | (NodeBase & { type: 'end' })
  | (NodeBase & { type: 'agent'; config: AgentNodeConfig })
  | (NodeBase & { type: 'condition'; config: ConditionNodeConfig })
  | (NodeBase & { type: 'approval'; config: ApprovalNodeConfig });

export interface WorkflowEdge {
  from: string;
  to: string;
  /** 有出口的節點必填；start / end 不能填。*/
  port?: WorkflowPort;
}

/**
 * 一個啟動參數：執行對話框上的一個欄位，樣板裡用 {{params.<name>}} 取用。
 * `kind` 決定那個欄位長什麼樣 —— 單行、多行，還是一個目錄。
 */
export interface WorkflowParamDef {
  name: string;
  label: string;
  kind: 'text' | 'multiline' | 'directory';
  required: boolean;
  default?: string;
  hint?: string;
}

export interface WorkflowDefinition {
  version: 1;
  id: string;
  name: string;
  /** 一句話說明這個工作流在做什麼；清單上顯示，選填。*/
  description?: string;
  /** 執行時要填的欄位；沒寫就是 DEFAULT_PARAMS (舊的定義都沒有這一欄)。*/
  params?: WorkflowParamDef[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** 一直以來的那兩個：任務與工作目錄。沒宣告參數的定義就是吃這兩個。*/
export const DEFAULT_PARAMS: readonly WorkflowParamDef[] = [
  { name: 'task', label: '任務', kind: 'multiline', required: true, hint: '要 agent 做什麼' },
  { name: 'cwd', label: '工作目錄', kind: 'directory', required: true, hint: 'agent 會在這裡修改檔案' },
];

/** 這份定義要填哪些參數。WorkflowInfo 也是這個形狀，所以清單上也問得到。*/
export function paramsOf(def: { params?: readonly WorkflowParamDef[] }): readonly WorkflowParamDef[] {
  return def.params ?? DEFAULT_PARAMS;
}

/**
 * 執行對話框填的值合不合法：必填的不能留白。純函式，
 * 對話框 (擋在送出之前) 與 main (workflow:start) 看的是同一份。
 */
export function validateRunParams(
  def: { params?: readonly WorkflowParamDef[] },
  values: Record<string, string>,
): string[] {
  const errors: string[] = [];
  for (const param of paramsOf(def)) {
    if (param.required && !(values[param.name] ?? '').trim()) errors.push(`請輸入${param.label}`);
  }
  return errors;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_TIMEOUT_SEC = 600;
/**
 * 執行對話框的用量上限預設值，只在 CLI 是用 API 金鑰登入時才填進去 ——
 * 訂閱帳號那個金額只是估算，沒有東西可以「超支」，所以預設不限制。
 */
export const DEFAULT_MAX_TOTAL_COST_USD = 2;

/**
 * 驗證工作流定義：回傳錯誤訊息陣列，空陣列代表合法。
 * 跟 validateProfile 一樣是純函式，放在 shared 讓 main 與之後的畫布共用。
 */
export function validateWorkflow(def: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const byId = new Map(def.nodes.map((node) => [node.id, node]));

  if (!def.name.trim()) errors.push('工作流名稱不能是空的');

  const params = paramsOf(def);
  const declared = new Set<string>();
  const directories = new Set<string>();
  for (const param of params) {
    if (!PARAM_NAME.test(param.name)) {
      errors.push(`參數名稱只能用英文、數字與底線，而且不能以數字開頭：${param.name}`);
    } else if (declared.has(param.name)) {
      errors.push(`參數名稱重複：${param.name}`);
    }
    if (!param.label.trim()) errors.push(`參數 ${param.name} 的標籤不能是空的`);
    declared.add(param.name);
    if (param.kind === 'directory') directories.add(param.name);
  }

  const starts = def.nodes.filter((node) => node.type === 'start');
  if (starts.length !== 1) errors.push(`必須剛好有一個開始節點 (目前 ${starts.length} 個)`);
  if (!def.nodes.some((node) => node.type === 'end')) errors.push('必須至少有一個結束節點');

  for (const node of def.nodes) {
    if (node.type === 'agent') {
      if (!node.config.prompt.trim()) errors.push(`節點 ${node.id} 的提示不能是空的`);
      if (!node.config.cwd?.trim()) errors.push(`節點 ${node.id} 的工作目錄不能是空的`);
      if (node.config.role !== undefined && !findRole(node.config.role)) {
        errors.push(`節點 ${node.id} 的角色不存在：${node.config.role}`);
      }
      if (node.config.permission !== undefined && !isAgentPermission(node.config.permission)) {
        errors.push(`節點 ${node.id} 的權限不存在：${node.config.permission}`);
      }
      for (const name of usedParams(node.config.prompt)) {
        if (!declared.has(name)) errors.push(`節點 ${node.id} 用到未定義的參數 ${name}`);
      }
      for (const name of usedParams(node.config.cwd ?? '')) {
        // 工作目錄代進去就是一個真的路徑，用的參數得是「目錄」那一種。
        if (!declared.has(name)) errors.push(`節點 ${node.id} 用到未定義的參數 ${name}`);
        else if (!directories.has(name)) {
          errors.push(`節點 ${node.id} 的工作目錄用的參數 ${name} 必須是目錄`);
        }
      }
    } else if (node.type === 'condition') {
      // 來源沒設或指到沒有輸出的節點，執行時那個條件永遠走「否」。
      const source = byId.get(node.config.source);
      if (source?.type !== 'agent') {
        errors.push(`節點 ${node.id} 的條件來源不存在：${node.config.source}`);
      }
      if (!compiles(node.config.rule)) errors.push(`節點 ${node.id} 的正規式無效`);
    }
  }

  const taken = new Set<string>();
  for (const edge of def.edges) {
    const from = byId.get(edge.from);
    if (!from) errors.push(`連線的起點節點不存在：${edge.from}`);
    if (!byId.has(edge.to)) errors.push(`連線的終點節點不存在：${edge.to}`);
    if (!from) continue;

    const ports = NODE_PORTS[from.type];
    if (ports.length === 0 && edge.port !== undefined) {
      errors.push(`${from.id} 是 ${from.type} 節點，連線不能指定出口`);
    } else if (ports.length > 0 && (edge.port === undefined || !ports.includes(edge.port))) {
      errors.push(`${from.id} 的出口必須是 ${ports.join(' 或 ')}`);
    }

    const key = `${edge.from}:${edge.port ?? ''}`;
    if (taken.has(key)) errors.push(`${from.id} 的出口 ${edge.port ?? '(單一)'} 重複連線`);
    taken.add(key);
  }

  for (const node of unreachable(def, starts[0])) {
    errors.push(`節點 ${node.id} 從開始節點走不到`);
  }

  return errors;
}

/** 參數名稱會直接寫進 {{params.x}}，所以限成一個識別字。*/
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 樣板裡用到的 {{params.x}}；寫法跟 shared/template.ts 的替換是同一種。*/
function usedParams(template: string): string[] {
  return [...template.matchAll(/\{\{\s*params\.([^.\s{}]+)\s*\}\}/g)].map((match) => match[1]);
}

/** 正規式是使用者打的，編不起來的話等到執行時才丟例外就太晚了。*/
function compiles(rule: ConditionRule): boolean {
  if (rule.type !== 'regex') return true;
  try {
    new RegExp(rule.pattern);
    return true;
  } catch {
    return false;
  }
}

/** 從開始節點做一次 BFS，沒被走到的都是孤兒。沒有開始節點時不重複報錯。*/
function unreachable(def: WorkflowDefinition, start: WorkflowNode | undefined): WorkflowNode[] {
  if (!start) return [];
  const seen = new Set([start.id]);
  const queue = [start.id];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const edge of def.edges) {
      if (edge.from !== id || seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return def.nodes.filter((node) => !seen.has(node.id));
}

/**
 * 一次執行的狀態，main 推給 renderer 畫清單用。
 * 'rejected' 是人按了「退回」：流程就這樣收掉，不是壞掉，所以跟 'failed' 分開。
 */
export type RunStatus =
  | 'running'
  | 'waiting_approval'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export type RunNodeStatus =
  | 'idle'
  | 'running'
  | 'done'
  | 'failed'
  | 'waiting'
  | 'skipped'
  | 'cancelled';

export interface RunNodeState {
  /** 節點在定義裡的顯示名稱，複製一份過來讓 renderer 不必拿到整份定義。*/
  label: string;
  /** agent 節點的角色，跟 label 一樣複製一份過來給 renderer 貼標籤。*/
  role?: AgentRole;
  /** agent 節點是哪一支 CLI；金額要標成估算還是費用看它。*/
  kind?: AgentKind;
  status: RunNodeStatus;
  /** 這個節點的 CLI 執行在畫面上對應的工作階段，點一下可以切過去看。*/
  sessionId?: string;
  costUsd?: number;
  attempts: number;
}

export interface RunState {
  runId: string;
  workflowId: string;
  name: string;
  status: RunStatus;
  /** 這次執行的啟動參數 (task、cwd)；畫布上的「手動操作」靠它代 {{params.x}}。*/
  params: Record<string, string>;
  /** status === 'waiting_approval' 時要問人的問題。*/
  question?: string;
  nodes: Record<string, RunNodeState>;
  totalCostUsd: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

/** 工作流在清單上的樣子；內建範本與自訂工作流共用一種。*/
export interface WorkflowInfo {
  id: string;
  name: string;
  /** 從定義複製過來的一句話說明，沒有就是沒有。*/
  description?: string;
  /** 執行對話框要照著長出欄位，所以清單上就帶著 paramsOf() 的結果。*/
  params: readonly WorkflowParamDef[];
  builtin: boolean;
}
