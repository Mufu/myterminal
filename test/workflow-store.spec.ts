import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowStore } from '../src/main/workflow/workflow-store';
import { minimalWorkflow } from './fakes/fake-workflow';

/** 假的檔案：WorkflowStore 只透過注入的讀／寫函式碰檔案系統。*/
class FakeFile {
  content: string | null = null;
  writes = 0;
  read = (): string | null => this.content;
  write = (content: string): void => {
    this.content = content;
    this.writes += 1;
  };
  parsed(): unknown {
    return JSON.parse(this.content ?? 'null');
  }
}

let file: FakeFile;
let store: WorkflowStore;

beforeEach(() => {
  file = new FakeFile();
  store = new WorkflowStore(file.read, file.write);
});

describe('WorkflowStore 讀取', () => {
  it('舊檔案的 allowEdits 讀進來換成 permission', () => {
    const old = minimalWorkflow('w') as unknown as {
      nodes: Array<{ config?: Record<string, unknown> }>;
    };
    old.nodes[1].config = { kind: 'claude', prompt: 'x', cwd: 'D:/work', allowEdits: true };
    file.content = JSON.stringify([old]);

    const node = store.list()[0].nodes[1];
    expect(node.type === 'agent' && node.config).toEqual({
      kind: 'claude',
      prompt: 'x',
      cwd: 'D:/work',
      permission: 'edit',
    });
  });

  it('兩個欄位都沒有的 agent 節點不補值 (執行那一側當成唯讀)', () => {
    const old = minimalWorkflow('w') as unknown as {
      nodes: Array<{ config?: Record<string, unknown> }>;
    };
    old.nodes[1].config = { kind: 'claude', prompt: 'x', cwd: 'D:/work' };
    file.content = JSON.stringify([old]);

    const node = store.list()[0].nodes[1];
    expect(node.type === 'agent' && node.config.permission).toBeUndefined();
  });

  it('檔案不存在時是空清單', () => {
    expect(store.list()).toEqual([]);
  });

  it('壞掉的 JSON 回傳空清單而不是丟例外', () => {
    file.content = '{ 這不是 JSON';
    expect(store.list()).toEqual([]);
  });

  it('內容不是陣列時回傳空清單', () => {
    file.content = JSON.stringify(minimalWorkflow('w'));
    expect(store.list()).toEqual([]);
  });

  it('讀出檔案裡的工作流', () => {
    file.content = JSON.stringify([minimalWorkflow('a', '甲'), minimalWorkflow('b', '乙')]);
    expect(store.list().map((w) => w.name)).toEqual(['甲', '乙']);
  });

  it('忽略缺欄位或版本不對的項目', () => {
    file.content = JSON.stringify([
      null,
      'x',
      { ...minimalWorkflow('v2'), version: 2 },
      { ...minimalWorkflow('no-id'), id: 3 },
      { ...minimalWorkflow('no-name'), name: undefined },
      { ...minimalWorkflow('no-nodes'), nodes: {} },
      { ...minimalWorkflow('no-edges'), edges: 'none' },
      minimalWorkflow('好的'),
    ]);
    expect(store.list().map((w) => w.id)).toEqual(['好的']);
  });

  /** 畫布畫到一半在 node.position.x 上丟例外的話，整個編輯器是一片空白。*/
  it('節點或連線的形狀不對也忽略', () => {
    const broken = (over: Record<string, unknown>) => ({
      ...minimalWorkflow('x'),
      ...over,
    });
    file.content = JSON.stringify([
      // 只有 id 的節點：沒有 type / label / position
      broken({ nodes: [{ id: 'x' }] }),
      // position 不是數字
      broken({
        nodes: [{ id: 'x', type: 'start', label: '開始', position: { x: '40', y: 0 } }],
      }),
      // 不認得的節點型別
      broken({
        nodes: [{ id: 'x', type: 'loop', label: 'x', position: { x: 0, y: 0 }, config: {} }],
      }),
      // agent 沒有 config
      broken({ nodes: [{ id: 'x', type: 'agent', label: 'x', position: { x: 0, y: 0 } }] }),
      // 連線的兩端不是字串
      broken({ edges: [{ from: 1, to: 2 }] }),
      minimalWorkflow('好的'),
    ]);
    expect(store.list().map((w) => w.id)).toEqual(['好的']);
  });

  /** 參數的形狀不對的話，執行對話框長欄位時會整個炸掉。*/
  it('啟動參數的形狀不對也忽略，沒宣告的照收', () => {
    file.content = JSON.stringify([
      { ...minimalWorkflow('不是陣列'), params: 'task' },
      { ...minimalWorkflow('沒有標籤'), params: [{ name: 'task', kind: 'text', required: true }] },
      { ...minimalWorkflow('型別不認得'), params: [{ name: 'a', label: 'a', kind: 'file', required: true }] },
      { ...minimalWorkflow('沒宣告') },
      { ...minimalWorkflow('宣告了'), params: [{ name: 'a', label: '甲', kind: 'text', required: false }] },
    ]);
    expect(store.list().map((w) => w.id)).toEqual(['沒宣告', '宣告了']);
  });

  /** 意義上的錯（提示留白）不能讓它消失 —— 使用者要看得到才改得了。*/
  it('只是驗證不過的定義仍然列得出來', () => {
    const blankPrompt = minimalWorkflow('沒提示');
    const node = blankPrompt.nodes[1];
    if (node.type === 'agent') node.config.prompt = '';
    file.content = JSON.stringify([blankPrompt]);
    expect(store.list().map((w) => w.id)).toEqual(['沒提示']);
  });

  it('get 依 id 拿一份，沒有就是 undefined', () => {
    store.save(minimalWorkflow('a'));
    expect(store.get('a')?.id).toBe('a');
    expect(store.get('沒有這個')).toBeUndefined();
  });

  it('每次 list 都重新讀檔', () => {
    expect(store.list()).toEqual([]);
    file.content = JSON.stringify([minimalWorkflow('後來才有的')]);
    expect(store.list().map((w) => w.id)).toEqual(['後來才有的']);
  });
});

describe('WorkflowStore 儲存', () => {
  it('save 把整份清單寫回檔案', () => {
    store.save(minimalWorkflow('a'));
    expect(file.parsed()).toEqual([minimalWorkflow('a')]);
    expect(store.list()).toEqual([minimalWorkflow('a')]);
  });

  it('新的 id 加在最後面', () => {
    store.save(minimalWorkflow('a'));
    store.save(minimalWorkflow('b'));
    expect(store.list().map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('同一個 id 覆寫，而且保留原本的順序', () => {
    store.save(minimalWorkflow('a'));
    store.save(minimalWorkflow('b'));
    store.save(minimalWorkflow('a', '改過名字'));
    expect(store.list().map((w) => w.name)).toEqual(['改過名字', 'b']);
  });

  it('不合法的定義丟例外，而且什麼都沒寫進去', () => {
    const broken = minimalWorkflow('壞的');
    broken.nodes = broken.nodes.filter((node) => node.type !== 'start');
    expect(() => store.save(broken)).toThrow(/開始節點/);
    expect(file.writes).toBe(0);
  });

  it('不能用內建範本的 id 蓋掉內建範本', () => {
    expect(() => store.save(minimalWorkflow('implement-review-approve'))).toThrow('不能覆蓋內建範本');
    expect(file.writes).toBe(0);
  });
});

describe('WorkflowStore 刪除', () => {
  it('remove 依 id 刪掉一份', () => {
    store.save(minimalWorkflow('a'));
    store.save(minimalWorkflow('b'));
    store.remove('a');
    expect(store.list().map((w) => w.id)).toEqual(['b']);
  });

  it('remove 不存在的 id 不會丟例外，也不會寫檔', () => {
    store.save(minimalWorkflow('a'));
    const before = file.writes;
    expect(() => store.remove('不存在')).not.toThrow();
    expect(file.writes).toBe(before);
    expect(store.list().map((w) => w.id)).toEqual(['a']);
  });
});
