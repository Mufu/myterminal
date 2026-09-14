import { describe, it, expect } from 'vitest';
import {
  parseClaudeAuth,
  parseCodexAuth,
  usageLabel,
  usageTitle,
} from '../src/shared/cli-auth';
import { chipLabel } from '../src/renderer/cli-status-view';

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
});
