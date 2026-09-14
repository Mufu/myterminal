import type {
  AgentNodeConfig,
  ApprovalNodeConfig,
  ConditionNodeConfig,
  NodePosition,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowPort,
} from '../shared/workflow';
import { NODE_PORTS, validateWorkflow } from '../shared/workflow';

/**
 * 畫布編輯器的狀態來源：一份 WorkflowDefinition 加上「選了誰、改過沒」。
 * 跟 AppState 一樣是 Observer，而且完全不碰 DOM ——
 * 版面用的尺寸常數與接點座標都在這裡算好，View 只負責把它畫出來，
 * 所以連線畫到哪、id 怎麼取、哪些連線不合法全部測得到。
 */

/** 節點卡片的寬、標頭高、一個出口佔的列高、座標吸附的格線。*/
export const NODE_WIDTH = 160;
export const NODE_HEADER = 30;
export const PORT_ROW = 22;
export const GRID = 10;

/** 出口在卡片上的名字。*/
export const PORT_LABELS: Record<WorkflowPort, string> = {
  ok: '成功',
  fail: '失敗',
  yes: '是',
  no: '否',
  approved: '批准',
  rejected: '退回',
};

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; index: number } | null;

/** 可以從調色盤加進畫布的型別；start 只有一個，由 newWorkflow() 放好。*/
export type AddableType = 'agent' | 'condition' | 'approval' | 'end';

/** 目前編輯的是哪來的定義：內建範本存下去會變成副本，所以要分得出來。*/
export type EditorSource = 'new' | 'builtin' | 'custom';

/** 屬性面板的輸入框只改自己那一個欄位，其餘保持原樣。*/
export interface NodePatch {
  label?: string;
  config?: Partial<AgentNodeConfig> | Partial<ConditionNodeConfig> | Partial<ApprovalNodeConfig>;
}

const LABELS: Record<AddableType, string> = {
  agent: 'Agent',
  condition: '條件',
  approval: '批准',
  end: '結束',
};

type Listener = () => void;

/** 自訂工作流的 id：跟內建範本的固定 id 撞不到。*/
export function newWorkflowId(): string {
  return `wf-${Math.random().toString(36).slice(2, 8)}`;
}

/** 座標吸附到格線上，拉出來的圖才會對齊。*/
export function snap(position: NodePosition): NodePosition {
  return { x: Math.round(position.x / GRID) * GRID, y: Math.round(position.y / GRID) * GRID };
}

/** 一張新畫布：只有開始與結束，中間留給使用者。*/
function blankWorkflow(): WorkflowDefinition {
  return {
    version: 1,
    id: newWorkflowId(),
    name: '新工作流',
    nodes: [
      { id: 'start', type: 'start', label: '開始', position: { x: 40, y: 120 } },
      { id: 'end', type: 'end', label: '結束', position: { x: 600, y: 120 } },
    ],
    edges: [],
  };
}

/** 定義就是純 JSON，所以深拷貝走 JSON —— 順便把 undefined 的欄位清掉。*/
function clone(definition: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(definition)) as WorkflowDefinition;
}

export class WorkflowEditorModel {
  private readonly listeners = new Set<Listener>();
  private _definition: WorkflowDefinition = blankWorkflow();
  private _selection: Selection = null;
  private _dirty = false;
  private _source: EditorSource = 'new';

  get definition(): WorkflowDefinition {
    return this._definition;
  }

  get selection(): Selection {
    return this._selection;
  }

  get dirty(): boolean {
    return this._dirty;
  }

  get source(): EditorSource {
    return this._source;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  newWorkflow(): void {
    this._definition = blankWorkflow();
    this._selection = null;
    this._source = 'new';
    this._dirty = false;
    this.notify();
  }

  /** 載入一份既有的定義；之後的編輯都動這份拷貝，不會改到來源。*/
  load(definition: WorkflowDefinition, source: 'builtin' | 'custom'): void {
    this._definition = clone(definition);
    this._selection = null;
    this._source = source;
    this._dirty = false;
    this.notify();
  }

  /** 存檔成功：內容跟檔案一致了，而且存下去的一律是自訂工作流。*/
  markSaved(): void {
    this._dirty = false;
    this._source = 'custom';
    this.notify();
  }

  setName(name: string): void {
    this._definition.name = name;
    this.touch();
  }

  select(selection: Selection): void {
    if (key(selection) === key(this._selection)) return;
    this._selection = selection;
    // 選取不是內容的改變，所以只通知不弄髒。
    this.notify();
  }

  addNode(type: AddableType, position?: NodePosition): string {
    const id = this.nextId(type);
    const at = snap(position ?? this.defaultPosition());
    const base = { id, label: LABELS[type], position: at };

    const node: WorkflowNode =
      type === 'agent'
        ? { ...base, type, config: { kind: 'claude', prompt: '', cwd: '{{params.cwd}}', allowEdits: false } }
        : type === 'condition'
          ? { ...base, type, config: { source: '', rule: { type: 'lastLineEquals', value: '' } } }
          : type === 'approval'
            ? { ...base, type, config: { question: '' } }
            : { ...base, type };

    this._definition.nodes.push(node);
    this.touch();
    return id;
  }

  moveNode(id: string, position: NodePosition): void {
    const node = this.node(id);
    if (!node) return;
    node.position = snap(position);
    this.touch();
  }

  /** 刪節點：開始節點刪不得，其餘連同它的連線與別人對它的參照一起清掉。*/
  removeNode(id: string): void {
    const node = this.node(id);
    if (!node || node.type === 'start') return;

    this._definition.nodes = this._definition.nodes.filter((n) => n.id !== id);
    this._definition.edges = this._definition.edges.filter((e) => e.from !== id && e.to !== id);

    for (const other of this._definition.nodes) {
      if (other.type === 'agent' && other.config.resumeFrom === id) other.config.resumeFrom = undefined;
      if (other.type === 'condition' && other.config.source === id) other.config.source = '';
    }

    // 連線的索引會跟著位移，選取一律清掉比較安全。
    this._selection = null;
    this.touch();
  }

  /**
   * 接線。回傳錯誤訊息，接得起來就回 null。
   * 同一個出口已經有線的時候是「改接」而不是多一條 —— 出口只能有一條。
   */
  connect(from: string, port: WorkflowPort | undefined, to: string): string | null {
    const source = this.node(from);
    const target = this.node(to);
    if (!source || !target) return '找不到節點';
    if (from === to) return '不能接回自己';
    if (target.type === 'start') return '開始節點不能當終點';

    const ports = NODE_PORTS[source.type];
    if (source.type === 'start') {
      if (port !== undefined) return '開始節點的連線不能指定出口';
    } else if (ports.length === 0) {
      return '結束節點沒有出口';
    } else if (port === undefined || !ports.includes(port)) {
      return `${source.id} 的出口必須是 ${ports.join(' 或 ')}`;
    }

    const edge: WorkflowEdge = port === undefined ? { from, to } : { from, to, port };
    const index = this._definition.edges.findIndex((e) => e.from === from && e.port === port);
    if (index >= 0) this._definition.edges[index] = edge;
    else this._definition.edges.push(edge);

    this.touch();
    return null;
  }

  removeEdge(index: number): void {
    if (index < 0 || index >= this._definition.edges.length) return;
    this._definition.edges.splice(index, 1);
    this._selection = null;
    this.touch();
  }

  updateNode(id: string, patch: NodePatch): void {
    const node = this.node(id);
    if (!node) return;
    if (patch.label !== undefined) node.label = patch.label;
    if (patch.config !== undefined && node.type !== 'start' && node.type !== 'end') {
      Object.assign(node.config as unknown as Record<string, unknown>, patch.config);
    }
    this.touch();
  }

  validate(): string[] {
    return validateWorkflow(this._definition);
  }

  /**
   * 接點在畫布座標上的位置：'in' 是左邊的入口，undefined 是開始節點那一個沒有名字的
   * 出口，其餘就是右邊第 i 列的出口。連線的兩端與畫面上的圓點都用它，不會對不齊。
   */
  portAnchor(nodeId: string, port: WorkflowPort | 'in' | undefined): NodePosition {
    const node = this.node(nodeId);
    if (!node) return { x: 0, y: 0 };
    const { x, y } = node.position;
    if (port === 'in') return { x, y: y + NODE_HEADER / 2 };
    if (port === undefined) return { x: x + NODE_WIDTH, y: y + NODE_HEADER / 2 };
    const index = Math.max(NODE_PORTS[node.type].indexOf(port), 0);
    return { x: x + NODE_WIDTH, y: y + NODE_HEADER + PORT_ROW * index + PORT_ROW / 2 };
  }

  node(id: string): WorkflowNode | undefined {
    return this._definition.nodes.find((n) => n.id === id);
  }

  /** `${type}-${n}`，n 從 1 開始找第一個沒被用掉的。*/
  private nextId(type: WorkflowNodeType): string {
    for (let n = 1; ; n += 1) {
      const id = `${type}-${n}`;
      if (!this.node(id)) return id;
    }
  }

  /** 沒指定位置就放在最右邊那個節點的右側。*/
  private defaultPosition(): NodePosition {
    let right: WorkflowNode | undefined;
    for (const node of this._definition.nodes) {
      if (!right || node.position.x > right.position.x) right = node;
    }
    if (!right) return { x: 40, y: 120 };
    return { x: right.position.x + NODE_WIDTH + 40, y: right.position.y };
  }

  private touch(): void {
    this._dirty = true;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function key(selection: Selection): string {
  if (!selection) return 'none';
  return selection.kind === 'node' ? `node:${selection.id}` : `edge:${selection.index}`;
}
