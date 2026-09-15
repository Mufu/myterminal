import { describe, it, expect } from 'vitest';
import {
  API_PROVIDERS,
  OPENCODE_FREE_MODEL,
  OPENCODE_FREE_PROVIDER,
  loginProfile,
  parseClaudeAuth,
  parseCodexAuth,
  parseMuseAuth,
  parseOpencodeAuth,
  providerNeedsKey,
  usageLabel,
  usageTitle,
  validateCliSetting,
} from '../src/shared/cli-auth';
import { chipLabel, statusUsable } from '../src/renderer/cli-status-view';

/** 這台機器上 `claude auth status` 真的印出來的那一行 (只留下會用到的欄位)。*/
const MAX_LOGIN =
  '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}';

describe('parseClaudeAuth', () => {
  it('claude.ai 登入是訂閱，方案名稱進 label', () => {
    expect(parseClaudeAuth(MAX_LOGIN)).toEqual({
      loggedIn: true,
      mode: 'subscription',
      plan: 'max',
      label: 'Max 訂閱',
    });
  });

  it('API 金鑰登入才是真的要付錢的那種', () => {
    const json = '{"loggedIn":true,"authMethod":"apiKey","apiProvider":"anthropic"}';
    expect(parseClaudeAuth(json)).toEqual({ loggedIn: true, mode: 'api', label: 'API 金鑰' });
  });

  it('沒登入就是沒登入', () => {
    expect(parseClaudeAuth('{"loggedIn":false}')).toEqual({
      loggedIn: false,
      mode: 'unknown',
      label: '未登入',
    });
  });

  it('沒有方案名稱的訂閱只說「訂閱」', () => {
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"claude.ai"}')).toMatchObject({
      mode: 'subscription',
      label: '訂閱',
    });
  });

  it('不認得的登入方式只確定「已登入」，不猜要不要付錢', () => {
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"bedrock"}')).toEqual({
      loggedIn: true,
      mode: 'unknown',
      label: '已登入',
    });
  });

  it('空字串、不是 JSON、不是物件都當成判斷不出來', () => {
    for (const raw of ['', 'not json', 'null', '[1,2]', '"x"']) {
      expect(parseClaudeAuth(raw)).toEqual({ loggedIn: false, mode: 'unknown', label: '無法判斷' });
    }
  });
});

describe('parseCodexAuth', () => {
  it('ChatGPT 登入是訂閱', () => {
    expect(parseCodexAuth('Logged in using ChatGPT\n')).toEqual({
      loggedIn: true,
      mode: 'subscription',
      plan: 'ChatGPT',
      label: 'ChatGPT 訂閱',
    });
  });

  it('API 金鑰登入是 api', () => {
    expect(parseCodexAuth('Logged in using API key')).toEqual({
      loggedIn: true,
      mode: 'api',
      label: 'API 金鑰',
    });
  });

  it('Not logged in 是沒登入', () => {
    expect(parseCodexAuth('Not logged in')).toMatchObject({ loggedIn: false, label: '未登入' });
  });

  it('空字串或看不懂的輸出都當成判斷不出來', () => {
    expect(parseCodexAuth('')).toMatchObject({ label: '無法判斷' });
    expect(parseCodexAuth('codex: command not found')).toMatchObject({ label: '無法判斷' });
  });
});

describe('usageLabel', () => {
  it('API 金鑰才是真的金額，其餘一律標成估算', () => {
    expect(usageLabel(0.0908, 'api')).toBe('$0.091');
    expect(usageLabel(0.0908, 'subscription')).toBe('≈$0.091');
    expect(usageLabel(0.0908, 'unknown')).toBe('≈$0.091');
    expect(usageLabel(0, 'api')).toBe('$0.000');
  });
});

describe('usageTitle', () => {
  it('三種登入方式各有一句解釋', () => {
    expect(usageTitle('subscription')).toContain('不另收費');
    expect(usageTitle('api')).toBe('這次執行的 API 費用');
    expect(usageTitle('unknown')).toContain('取決於 CLI 的登入方式');
  });
});

describe('chipLabel', () => {
  it('名稱加上登入方式，還沒探測完先寫檢查中', () => {
    expect(chipLabel('Claude', parseClaudeAuth(MAX_LOGIN))).toBe('Claude · Max 訂閱');
    expect(chipLabel('Codex', parseCodexAuth('Not logged in'))).toBe('Codex · 未登入');
    expect(chipLabel('Codex', undefined)).toBe('Codex · 檢查中…');
  });

  /** 工作階段是拿那把金鑰跑的，所以晟片上要寫金鑰，不是 CLI 自己的登入狀態。*/
  it('選了 API 金鑰而且存得住時以設定為準', () => {
    const auth = parseClaudeAuth(MAX_LOGIN);
    expect(chipLabel('Claude', auth, { mode: 'apiKey', hasKey: true })).toBe('Claude · API 金鑰');
    expect(statusUsable(auth, { mode: 'apiKey', hasKey: true })).toBe(true);
  });

  it('選了 API 金鑰但一把都沒存時，還是看探測結果', () => {
    const auth = parseCodexAuth('Not logged in');
    expect(chipLabel('Codex', auth, { mode: 'apiKey', hasKey: false })).toBe('Codex · 未登入');
    expect(statusUsable(auth, { mode: 'apiKey', hasKey: false })).toBe(false);
  });
});

describe('parseMuseAuth', () => {
  it('憑證檔不存在 (從沒登入過) 是未登入', () => {
    expect(parseMuseAuth(null)).toEqual({ loggedIn: false, mode: 'unknown', label: '未登入' });
  });

  it('muse logout 之後 providers 是空的，檔案還在也算未登入', () => {
    expect(parseMuseAuth('{"schema_version":1,"providers":{}}')).toMatchObject({
      loggedIn: false,
      label: '未登入',
    });
  });

  it('muse auth set 存的是 api_key，算成 API 金鑰', () => {
    const file = '{"schema_version":1,"providers":{"meta":{"api_key":"祕密"}}}';
    expect(parseMuseAuth(file)).toEqual({ loggedIn: true, mode: 'api', label: 'API 金鑰' });
  });

  it('muse login 存的不是 api_key，算成 Meta 帳號', () => {
    const file = '{"schema_version":1,"providers":{"meta":{"refresh_token":"x"}}}';
    expect(parseMuseAuth(file)).toMatchObject({ mode: 'subscription', label: 'Meta 帳號' });
  });

  it('壞掉的檔案只能說無法判斷', () => {
    expect(parseMuseAuth('{ 不是 JSON')).toMatchObject({ label: '無法判斷' });
  });
});

describe('parseOpencodeAuth', () => {
  /** `opencode auth list` 的輸出前面有顏色跳脫序列。*/
  const NONE = '\u001b[90m└\u001b[39m  0 credentials\n';

  it('0 credentials 是未登入', () => {
    expect(parseOpencodeAuth(NONE)).toMatchObject({ loggedIn: false, label: '未登入' });
  });

  it('有憑證就是 API 金鑰', () => {
    expect(parseOpencodeAuth('3 credentials')).toEqual({
      loggedIn: true,
      mode: 'api',
      label: 'API 金鑰',
    });
  });

  it('opencode 自己沒憑證，但 app 存了金鑰一樣跑得起來', () => {
    expect(parseOpencodeAuth(NONE, true)).toMatchObject({ mode: 'api' });
  });

  it('看不懂的輸出是無法判斷', () => {
    expect(parseOpencodeAuth('???')).toMatchObject({ label: '無法判斷' });
  });
});

describe('loginProfile', () => {
  it('三支有登入流程的 CLI 各自開一個互動式工作階段', () => {
    expect(loginProfile('claude')).toMatchObject({
      type: 'claude',
      baseShell: 'powershell',
      startupCommand: 'claude auth login',
    });
    expect(loginProfile('codex')).toMatchObject({ startupCommand: 'codex login' });
    // Muse 在 Windows 上有原生安裝，登入不必進 WSL。
    expect(loginProfile('muse')).toMatchObject({
      baseShell: 'powershell',
      startupCommand: 'muse login',
    });
  });

  it('OpenCode 沒有登入流程', () => {
    expect(() => loginProfile('opencode')).toThrow('OpenCode 只能使用 API 金鑰');
  });
});

describe('validateCliSetting', () => {
  it('選了登入就不必填金鑰', () => {
    expect(validateCliSetting({ id: 'claude', mode: 'login' }, false)).toEqual([]);
  });

  it('選了 API 金鑰但沒填也沒存過', () => {
    expect(validateCliSetting({ id: 'claude', mode: 'apiKey' }, false)).toEqual(['請輸入 API 金鑰']);
  });

  it('已經存過就可以不重打', () => {
    expect(validateCliSetting({ id: 'claude', mode: 'apiKey' }, true)).toEqual([]);
  });

  it('OpenCode 不能選登入', () => {
    expect(
      validateCliSetting({ id: 'opencode', mode: 'login' }, true),
    ).toContain('OpenCode 只能使用 API 金鑰');
  });

  it('OpenCode 一定要選供應商 —— 金鑰要放進哪一個環境變數看它', () => {
    expect(validateCliSetting({ id: 'opencode', mode: 'apiKey', apiKey: 'k' }, false)).toEqual([
      '請選擇供應商',
    ]);
    expect(
      validateCliSetting({ id: 'opencode', mode: 'apiKey', apiKey: 'k', provider: 'google' }, false),
    ).toEqual([]);
  });

  /** opencode 自家的免費模型不必金鑰，所以那一格是空的也存得起來。*/
  it('OpenCode 的免費模型不必填金鑰', () => {
    expect(
      validateCliSetting({ id: 'opencode', mode: 'apiKey', provider: OPENCODE_FREE_PROVIDER }, false),
    ).toEqual([]);
  });
});

describe('OpenCode 的供應商清單', () => {
  it('自家的免費模型也是一個選項', () => {
    const free = API_PROVIDERS.find((provider) => provider.id === OPENCODE_FREE_PROVIDER);
    expect(free?.label).toBe('OpenCode 免費模型（不需金鑰）');
  });

  it('只有免費那一家不必金鑰', () => {
    expect(providerNeedsKey(OPENCODE_FREE_PROVIDER)).toBe(false);
    for (const { id } of API_PROVIDERS.filter((p) => p.id !== OPENCODE_FREE_PROVIDER)) {
      expect(providerNeedsKey(id)).toBe(true);
    }
  });

  it('免費模型的型號就是實測跑得起來的那一個', () => {
    expect(`${OPENCODE_FREE_PROVIDER}/${OPENCODE_FREE_MODEL}`).toBe('opencode/mimo-v2.5-free');
  });
});
