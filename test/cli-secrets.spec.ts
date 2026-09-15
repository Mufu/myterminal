import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cliInjection, cliSecrets, MUSE_WSLENV } from '../src/main/cli-secrets';
import { CliAuthStore } from '../src/main/cli-auth-store';
import type { Cipher } from '../src/main/cli-auth-store';
import { ShellFactory, mergeWslenv } from '../src/main/shell-factory';
import type { CliAuthSetting } from '../src/shared/cli-auth';

const KEY = 'sk-test-key';
const apiKey = (extra: Partial<CliAuthSetting> = {}): CliAuthSetting => ({
  mode: 'apiKey',
  hasKey: true,
  ...extra,
});
const login: CliAuthSetting = { mode: 'login', hasKey: true };

describe('cliInjection 的環境變數對應', () => {
  it('Claude 用 ANTHROPIC_API_KEY', () => {
    expect(cliInjection('claude', apiKey(), KEY, 'powershell').env).toEqual({
      ANTHROPIC_API_KEY: KEY,
    });
  });

  it('Codex 用 OPENAI_API_KEY', () => {
    expect(cliInjection('codex', apiKey(), KEY, 'powershell').env).toEqual({
      OPENAI_API_KEY: KEY,
    });
  });

  it('Muse 在 Windows 原生執行時只要 META_API_KEY', () => {
    expect(cliInjection('muse', apiKey(), KEY, 'powershell').env).toEqual({
      META_API_KEY: KEY,
    });
  });

  it('Muse 跑在 WSL 裡才要 WSLENV，否則變數過不去', () => {
    expect(cliInjection('muse', apiKey(), KEY, 'wsl').env).toEqual({
      META_API_KEY: KEY,
      WSLENV: MUSE_WSLENV,
    });
  });

  it('OpenCode 依供應商決定環境變數', () => {
    const env = (provider: CliAuthSetting['provider']) =>
      cliInjection('opencode', apiKey({ provider }), KEY, 'powershell').env;
    expect(env('anthropic')).toEqual({ ANTHROPIC_API_KEY: KEY });
    expect(env('openai')).toEqual({ OPENAI_API_KEY: KEY });
    expect(env('openrouter')).toEqual({ OPENROUTER_API_KEY: KEY });
    // google 那家吃三個名字，真正被 AI SDK 讀走的是這一個。
    expect(env('google')).toEqual({ GOOGLE_GENERATIVE_AI_API_KEY: KEY });
  });

  it('沒選供應商時 OpenCode 不注入任何東西', () => {
    expect(cliInjection('opencode', apiKey(), KEY, 'powershell').env).toEqual({});
  });
});

describe('cliInjection 的登入模式', () => {
  it('選登入時什麼都不注入', () => {
    expect(cliInjection('claude', login, KEY, 'powershell').env).toEqual({});
    expect(cliInjection('codex', login, KEY, 'powershell').env).toEqual({});
  });

  it('選登入時特別不能留下 META_API_KEY —— 它的優先度高過 muse login', () => {
    expect(cliInjection('muse', login, KEY, 'wsl').env).toEqual({});
  });

  it('選了 API 金鑰但一把都沒存時也不注入', () => {
    expect(cliInjection('claude', { mode: 'apiKey', hasKey: false }, undefined, 'powershell').env)
      .toEqual({});
  });
});

describe('cliInjection 的 OpenCode 型號', () => {
  it('設了型號就改寫啟動指令', () => {
    const injection = cliInjection(
      'opencode',
      apiKey({ provider: 'openrouter', model: 'z-ai/glm-5' }),
      KEY,
      'powershell',
    );
    expect(injection.startupCommand).toBe('opencode -m openrouter/z-ai/glm-5');
  });

  it('沒設型號就不改寫 (讓 opencode 自己挑)', () => {
    const injection = cliInjection('opencode', apiKey({ provider: 'google' }), KEY, 'powershell');
    expect(injection.startupCommand).toBeUndefined();
  });

  it('型號跟金鑰無關：沒存金鑰也照樣指定型號', () => {
    const setting: CliAuthSetting = {
      mode: 'apiKey',
      hasKey: false,
      provider: 'openai',
      model: 'gpt-5.5',
    };
    expect(cliInjection('opencode', setting, undefined, 'powershell').startupCommand).toBe(
      'opencode -m openai/gpt-5.5',
    );
  });
});

describe('mergeWslenv', () => {
  it('本來沒有 WSLENV 就只有這一項', () => {
    expect(mergeWslenv(undefined, MUSE_WSLENV)).toBe(MUSE_WSLENV);
  });

  it('接在使用者自己設的後面，不蓋掉別人的', () => {
    expect(mergeWslenv('FOO/p:BAR/u', MUSE_WSLENV)).toBe(`FOO/p:BAR/u:${MUSE_WSLENV}`);
  });

  it('已經有了就不重複加', () => {
    expect(mergeWslenv(`FOO/p:${MUSE_WSLENV}`, MUSE_WSLENV)).toBe(`FOO/p:${MUSE_WSLENV}`);
  });
});

/** 假的加解密：跟 CliAuthStore 的測試同一套。*/
const cipher: Cipher = {
  encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (secret) => Buffer.from(secret.slice(4), 'base64').toString('utf8'),
};

describe('ShellFactory 注入金鑰', () => {
  let content: string | null;
  let factory: ShellFactory;
  const originalWslenv = process.env.WSLENV;

  beforeEach(() => {
    content = null;
    const store = new CliAuthStore(
      () => content,
      (next) => (content = next),
      cipher,
    );
    factory = new ShellFactory((name) => `RESOLVED(${name})`, cliSecrets(store));
    store.set('claude', { mode: 'apiKey', apiKey: KEY });
    store.set('muse', { mode: 'apiKey', apiKey: 'meta-key' });
    store.set('opencode', { mode: 'apiKey', apiKey: 'or-key', provider: 'openrouter', model: 'z/glm' });
  });

  afterEach(() => {
    if (originalWslenv === undefined) delete process.env.WSLENV;
    else process.env.WSLENV = originalWslenv;
  });

  it('Claude 的工作階段帶得到 ANTHROPIC_API_KEY', () => {
    const spec = factory.create({ type: 'claude', baseShell: 'powershell' });
    expect(spec.env.ANTHROPIC_API_KEY).toBe(KEY);
  });

  it('沒設定過的那一支不會被注入', () => {
    const spec = factory.create({ type: 'codex', baseShell: 'powershell' });
    expect(spec.env.OPENAI_API_KEY).toBeUndefined();
  });

  it('Muse 跑在 WSL 上時 WSLENV 是合併進去的，不會蓋掉原本的', () => {
    process.env.WSLENV = 'MY_VAR/u';
    const spec = factory.create({ type: 'muse', baseShell: 'wsl' });
    expect(spec.env.META_API_KEY).toBe('meta-key');
    expect(spec.env.WSLENV).toBe(`MY_VAR/u:${MUSE_WSLENV}`);
  });

  it('OpenCode 設了型號時啟動指令換成 opencode -m', () => {
    const spec = factory.create({ type: 'opencode', baseShell: 'powershell' });
    expect(spec.env.OPENROUTER_API_KEY).toBe('or-key');
    expect(spec.startupCommand).toBe('opencode -m openrouter/z/glm');
  });

  it('使用者自己改過啟動指令的話尊重他，不套型號', () => {
    const spec = factory.create({
      type: 'opencode',
      baseShell: 'powershell',
      startupCommand: 'opencode --continue',
    });
    expect(spec.startupCommand).toBe('opencode --continue');
  });

  it('啟動指令還是預設的那個字時，才換成帶型號的版本', () => {
    const spec = factory.create({
      type: 'opencode',
      baseShell: 'powershell',
      startupCommand: 'opencode',
    });
    expect(spec.startupCommand).toBe('opencode -m openrouter/z/glm');
  });
});
