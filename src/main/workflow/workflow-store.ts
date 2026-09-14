import { readFileSync, writeFileSync } from 'node:fs';
import type { WorkflowDefinition } from '../../shared/workflow';
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
      return Array.isArray(parsed) ? parsed.filter(isWorkflowDefinition) : [];
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

/** 手動編輯過的 JSON 也可能少欄位，形狀不對的項目直接忽略。*/
function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const { version, id, name, nodes, edges } = value as Partial<WorkflowDefinition>;
  return (
    version === 1 &&
    typeof id === 'string' &&
    typeof name === 'string' &&
    Array.isArray(nodes) &&
    Array.isArray(edges)
  );
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
