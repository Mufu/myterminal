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
