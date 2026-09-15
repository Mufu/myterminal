import { describe, it, expect, beforeEach } from 'vitest';
import { CliAuthStore } from '../src/main/cli-auth-store';
import type { Cipher } from '../src/main/cli-auth-store';

/** 假的檔案：CliAuthStore 只透過注入的讀／寫函式碰檔案系統。*/
class FakeFile {
  content: string | null = null;
  read = (): string | null => this.content;
  write = (content: string): void => {
    this.content = content;
  };
  parsed(): Record<string, { mode: string; key?: string; provider?: string; model?: string }> {
    return JSON.parse(this.content ?? 'null');
  }
}

/**
 * 假的加解密：不是真的加密，但跟 safeStorage 一樣「落地的東西看不出原文」，
 * 所以「設定檔裡不能有明文」那條測試才驗得到東西。
 */
const cipher: Cipher = {
  encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (secret) => {
    if (!secret.startsWith('enc:')) throw new Error('解不開');
    return Buffer.from(secret.slice(4), 'base64').toString('utf8');
  },
};

let file: FakeFile;
let store: CliAuthStore;

beforeEach(() => {
  file = new FakeFile();
  store = new CliAuthStore(file.read, file.write, cipher);
});

describe('CliAuthStore 預設值', () => {
  it('還沒設定過時：三支 CLI 預設用登入，OpenCode 只能用 API 金鑰', () => {
    const settings = store.settings();
    expect(settings.claude).toEqual({ mode: 'login', hasKey: false });
    expect(settings.codex).toEqual({ mode: 'login', hasKey: false });
    expect(settings.muse).toEqual({ mode: 'login', hasKey: false });
    expect(settings.opencode).toEqual({ mode: 'apiKey', hasKey: false });
  });

  it('壞掉的 JSON 當成還沒設定過，不會丟例外', () => {
    file.content = '{ 這不是 JSON';
    expect(store.get('claude')).toEqual({ mode: 'login', hasKey: false });
  });

  it('形狀壞掉的那一列忽略，其他的照讀', () => {
    file.content = JSON.stringify({ claude: { mode: '亂填' }, codex: { mode: 'apiKey' } });
    expect(store.get('claude').mode).toBe('login');
    expect(store.get('codex').mode).toBe('apiKey');
  });
});

describe('CliAuthStore 儲存金鑰', () => {
  it('金鑰加密後才落地，設定檔裡看不到明文', () => {
    store.set('claude', { mode: 'apiKey', apiKey: 'sk-secret' });
    expect(file.content).not.toContain('sk-secret');
    expect(file.parsed().claude.key).toBe(`enc:${Buffer.from('sk-secret').toString('base64')}`);
  });

  it('renderer 拿到的設定只有「存了沒有」，沒有金鑰本身', () => {
    store.set('claude', { mode: 'apiKey', apiKey: 'sk-secret' });
    expect(store.get('claude')).toEqual({ mode: 'apiKey', hasKey: true });
  });

  it('secretFor 解得開剛存進去的金鑰', () => {
    store.set('codex', { mode: 'apiKey', apiKey: '  sk-trimmed  ' });
    expect(store.secretFor('codex')).toBe('sk-trimmed');
  });

  it('選「登入」時 secretFor 不給金鑰，即使檔案裡還存著', () => {
    store.set('muse', { mode: 'apiKey', apiKey: 'meta-key' });
    store.set('muse', { mode: 'login' });
    expect(store.get('muse')).toEqual({ mode: 'login', hasKey: true });
    expect(store.secretFor('muse')).toBeUndefined();
  });

  it('沒重打金鑰就沿用舊的，不會被清掉', () => {
    store.set('claude', { mode: 'apiKey', apiKey: 'sk-1' });
    store.set('claude', { mode: 'apiKey' });
    expect(store.secretFor('claude')).toBe('sk-1');
  });

  it('重打金鑰就換掉舊的', () => {
    store.set('claude', { mode: 'apiKey', apiKey: 'sk-1' });
    store.set('claude', { mode: 'apiKey', apiKey: 'sk-2' });
    expect(store.secretFor('claude')).toBe('sk-2');
  });

  it('解不開的金鑰 (換一台機器) 當成沒有，不丟例外', () => {
    file.content = JSON.stringify({ claude: { mode: 'apiKey', key: '別台機器加密的' } });
    expect(store.get('claude').hasKey).toBe(true);
    expect(store.secretFor('claude')).toBeUndefined();
  });

  it('clearKey 只清金鑰，登入方式留著', () => {
    store.set('claude', { mode: 'apiKey', apiKey: 'sk-1' });
    store.clearKey('claude');
    expect(store.get('claude')).toEqual({ mode: 'apiKey', hasKey: false });
    expect(store.secretFor('claude')).toBeUndefined();
  });

  it('本來就沒有金鑰時 clearKey 不寫檔', () => {
    store.clearKey('claude');
    expect(file.content).toBeNull();
  });
});

describe('CliAuthStore 的 OpenCode 欄位', () => {
  it('供應商與型號跟著存，下一次讀得回來', () => {
    store.set('opencode', {
      mode: 'apiKey',
      apiKey: 'or-key',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
    });
    expect(store.get('opencode')).toEqual({
      mode: 'apiKey',
      hasKey: true,
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
    });
  });

  it('型號留空就是不指定，供應商沒重送則沿用', () => {
    store.set('opencode', { mode: 'apiKey', apiKey: 'k', provider: 'google', model: 'gemini-3' });
    store.set('opencode', { mode: 'apiKey', model: '  ' });
    expect(store.get('opencode')).toEqual({ mode: 'apiKey', hasKey: true, provider: 'google' });
  });
});
