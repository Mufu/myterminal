import { describe, it, expect, beforeEach } from 'vitest';
import { SettingsStore } from '../src/main/settings-store';

/** 假的檔案：SettingsStore 只透過注入的讀／寫函式碰檔案系統。*/
class FakeFile {
  content: string | null = null;
  read = (): string | null => this.content;
  write = (content: string): void => {
    this.content = content;
  };
}

let file: FakeFile;
let store: SettingsStore;

beforeEach(() => {
  file = new FakeFile();
  store = new SettingsStore(file.read, file.write);
});

describe('SettingsStore', () => {
  it('檔案不存在時什麼都還沒設定', () => {
    expect(store.get()).toEqual({});
  });

  it('存下來再讀回去', () => {
    store.setRolesDir('D:\\roles');
    expect(store.get()).toEqual({ rolesDir: 'D:\\roles' });
  });

  it('空字串代表回到預設目錄', () => {
    store.setRolesDir('D:\\roles');
    store.setRolesDir('   ');
    expect(store.get()).toEqual({});
  });

  it('壞掉的 JSON 當成什麼都沒設定，不丟例外', () => {
    file.content = '{ 不是 JSON';
    expect(store.get()).toEqual({});
    file.content = '[]';
    expect(store.get()).toEqual({});
  });

  it('手改過的檔案裡 rolesDir 不是字串就忽略', () => {
    file.content = JSON.stringify({ rolesDir: 123 });
    expect(store.get()).toEqual({});
  });
});
