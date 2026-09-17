import { readFileSync, writeFileSync } from 'node:fs';
import type { AgentPermission } from '../../shared/agent';
import { readPermission } from '../../shared/agent';
import type { AgentNodeConfig, WorkflowDefinition, WorkflowNode } from '../../shared/workflow';
import { validateWorkflow } from '../../shared/workflow';
import { findTemplate } from './templates';

/** 讀檔的縫線：回傳整個檔案內容，檔案不存在時回傳 null。*/
export type WorkflowReader = () => string | null;
/** 寫檔的縫線：每次都覆寫整個檔案。*/
export type WorkflowWriter = (content: string) => void;

/**
 * WorkflowStore — 自訂工作流定義的 Repository，跟 ProfileStore 同一個寫法。
 * 存的就是畫布編輯的那份 WorkflowDefinition，一份檔案一個 JSON 陣列；
 * 檔案壞掉或不存在時一律當成空清單，不讓一份壞掉的 JSON 卡住整個 app。
 */
export class WorkflowStore {
  constructor(
    private readonly read: WorkflowReader,
    private readonly write: WorkflowWriter,
  ) {}

  list(): WorkflowDefinition[] {
    const raw = this.read();
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isWorkflowDefinition).map(migrate) : [];
    } catch {
      return [];
    }
  }

  get(id: string): WorkflowDefinition | undefined {
    return this.list().find((definition) => definition.id === id);
  }

  /** 以 id upsert；覆寫時保留原本的順序。不合法就整份不寫。*/
  save(definition: WorkflowDefinition): void {
    const errors = validateWorkflow(definition);
    if (errors.length > 0) throw new Error(errors.join('\n'));
    if (findTemplate(definition.id)) throw new Error('不能覆蓋內建範本');

    const definitions = this.list();
    const index = definitions.findIndex((d) => d.id === definition.id);
    if (index >= 0) definitions[index] = definition;
    else definitions.push(definition);
    this.persist(definitions);
  }

  remove(id: string): void {
    const definitions = this.list();
    const rest = definitions.filter((d) => d.id !== id);
    if (rest.length === definitions.length) return;
    this.persist(rest);
  }

  private persist(definitions: WorkflowDefinition[]): void {
    this.write(JSON.stringify(definitions, null, 2));
  }
}

/**
 * 舊檔案的 agent 節點只有 allowEdits 兩檔 (true/false)，讀進來就換成三檔的
 * permission；之後畫布存回去寫的就是新欄位，舊的不再留著。
 */
function migrate(definition: WorkflowDefinition): WorkflowDefinition {
  return { ...definition, nodes: definition.nodes.map(migrateNode) };
}

function migrateNode(node: WorkflowNode): WorkflowNode {
  if (node.type !== 'agent') return node;
  const config: AgentNodeConfig & { allowEdits?: unknown; permission?: AgentPermission } = {
    ...node.config,
  };
  const permission = readPermission(config as unknown as Record<string, unknown>);
  delete config.allowEdits;
  if (permission) config.permission = permission;
  return { ...node, config };
}

const NODE_TYPES: readonly string[] = ['start', 'end', 'agent', 'condition', 'approval'];

/**
 * 手動編輯過的 JSON 也可能少欄位，形狀不對的項目直接忽略 ——
 * 連節點裡面都要看，不然畫布畫到一半會在 node.position.x 上丟例外，畫出一片空白。
 * 這裡只看「形狀對不對」，不跑 validateWorkflow ——
 * 提示留白這種意義上的錯要還看得到、也改得了。
 */
function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const { version, id, name, nodes, edges } = value as Partial<WorkflowDefinition>;
  return (
    version === 1 &&
    typeof id === 'string' &&
    typeof name === 'string' &&
    Array.isArray(nodes) &&
    nodes.every(isNode) &&
    Array.isArray(edges) &&
    edges.every(isEdge)
  );
}

function isNode(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { id, type, label, position, config } = value as Record<string, unknown>;
  if (typeof id !== 'string' || typeof label !== 'string') return false;
  if (typeof type !== 'string' || !NODE_TYPES.includes(type)) return false;
  if (typeof position !== 'object' || position === null) return false;
  const { x, y } = position as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number') return false;
  // start / end 沒有 config，其餘三種一定要有一個物件。
  if (type === 'start' || type === 'end') return true;
  return typeof config === 'object' && config !== null;
}

function isEdge(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { from, to } = value as Record<string, unknown>;
  return typeof from === 'string' && typeof to === 'string';
}

/** 正式環境：整份檔案一次讀進來、一次覆寫回去。*/
export function fileWorkflowStore(path: string): WorkflowStore {
  return new WorkflowStore(
    () => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    (content) => writeFileSync(path, content, 'utf8'),
  );
}
