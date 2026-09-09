import { describe, it, expect, beforeEach } from 'vitest';
import { ProfileStore } from '../src/main/profile-store';
import type { SavedProfile } from '../src/shared/profile';

/** 假的檔案：ProfileStore 只透過注入的讀／寫函式碰檔案系統。*/
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

const ps = (name: string): SavedProfile => ({ type: 'powershell', name });

let file: FakeFile;
let store: ProfileStore;

beforeEach(() => {
  file = new FakeFile();
  store = new ProfileStore(file.read, file.write);
});

describe('ProfileStore 讀取', () => {
  it('檔案不存在時是空清單', () => {
    expect(store.list()).toEqual([]);
  });

  it('讀出檔案裡的設定檔', () => {
    file.content = JSON.stringify([ps('我的 PS'), { type: 'ssh', name: '部署機', host: 'h', user: 'u' }]);
    expect(store.list()).toHaveLength(2);
    expect(store.list()[0]).toEqual({ type: 'powershell', name: '我的 PS' });
  });

  it('壞掉的 JSON 回傳空清單而不是丟例外', () => {
    file.content = '{ 這不是 JSON';
    expect(store.list()).toEqual([]);
  });

  it('內容不是陣列時回傳空清單', () => {
    file.content = '{"name":"x"}';
    expect(store.list()).toEqual([]);
  });

  it('忽略沒有名稱或沒有類型的項目', () => {
    file.content = JSON.stringify([{ type: 'powershell' }, { name: '  ' }, ps('好的')]);
    expect(store.list()).toEqual([ps('好的')]);
  });

  it('每次 list 都重新讀檔', () => {
    expect(store.list()).toEqual([]);
    file.content = JSON.stringify([ps('後來才有的')]);
    expect(store.list()).toEqual([ps('後來才有的')]);
  });
});

describe('ProfileStore 儲存', () => {
  it('save 把整份清單寫回檔案', () => {
    store.save(ps('我的 PS'));
    expect(file.parsed()).toEqual([ps('我的 PS')]);
    expect(store.list()).toEqual([ps('我的 PS')]);
  });

  it('save 以名稱 upsert，不會出現兩個同名的設定檔', () => {
    store.save({ type: 'ssh', name: '部署機', host: 'old', user: 'u' });
    store.save({ type: 'ssh', name: '部署機', host: 'new', user: 'u' });
    expect(store.list()).toEqual([{ type: 'ssh', name: '部署機', host: 'new', user: 'u' }]);
  });

  it('覆寫同名設定檔時保留原本的順序', () => {
    store.save(ps('A'));
    store.save(ps('B'));
    store.save({ type: 'wsl', name: 'A', distro: 'Ubuntu' });
    expect(store.list().map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('名稱區分大小寫，是兩個不同的設定檔', () => {
    store.save(ps('deploy'));
    store.save(ps('Deploy'));
    expect(store.list().map((p) => p.name)).toEqual(['deploy', 'Deploy']);
  });

  it('save 會去掉名稱前後的空白', () => {
    store.save(ps('  我的 PS  '));
    expect(store.list()[0].name).toBe('我的 PS');
  });

  it('名稱是空白時拒絕儲存', () => {
    expect(() => store.save(ps('   '))).toThrow();
    expect(file.writes).toBe(0);
  });
});

describe('ProfileStore 刪除', () => {
  it('remove 依名稱刪掉一筆', () => {
    store.save(ps('A'));
    store.save(ps('B'));
    store.remove('A');
    expect(store.list().map((p) => p.name)).toEqual(['B']);
  });

  it('remove 不存在的名稱不會丟例外', () => {
    store.save(ps('A'));
    expect(() => store.remove('不存在')).not.toThrow();
    expect(store.list().map((p) => p.name)).toEqual(['A']);
  });
});
