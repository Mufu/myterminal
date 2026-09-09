import { describe, it, expect } from 'vitest';
import { validateProfile } from '../src/shared/validate-profile';

describe('validateProfile', () => {
  it('PowerShell 不需要額外欄位', () => {
    expect(validateProfile({ type: 'powershell' })).toEqual([]);
  });

  it('SSH 缺主機或使用者時報錯', () => {
    const errors = validateProfile({ type: 'ssh', host: '', user: '' });
    expect(errors).toContain('請輸入主機位址');
    expect(errors).toContain('請輸入使用者名稱');
  });

  it('SSH 欄位齊全時通過', () => {
    expect(validateProfile({ type: 'ssh', host: 'example.com', user: 'robert' })).toEqual([]);
  });

  it('SSH 連接埠超出範圍時報錯', () => {
    expect(validateProfile({ type: 'ssh', host: 'h', user: 'u', port: 0 })).toContain(
      '連接埠必須介於 1 到 65535',
    );
    expect(validateProfile({ type: 'ssh', host: 'h', user: 'u', port: 70000 })).toContain(
      '連接埠必須介於 1 到 65535',
    );
  });

  it('自訂命令必須有執行檔', () => {
    expect(validateProfile({ type: 'custom', file: '  ' })).toContain('請輸入執行檔');
  });

  it('Claude 的啟動指令不可以是空字串', () => {
    expect(
      validateProfile({ type: 'claude', baseShell: 'powershell', startupCommand: '   ' }),
    ).toContain('請輸入啟動指令');
  });

  it('Claude 省略啟動指令時使用預設值，視為合法', () => {
    expect(validateProfile({ type: 'claude', baseShell: 'powershell' })).toEqual([]);
  });
});

describe('validateProfile 要儲存設定檔時', () => {
  it('沒有名稱就報錯', () => {
    expect(validateProfile({ type: 'powershell' }, true)).toEqual(['儲存設定時必須填名稱']);
  });

  it('名稱只有空白也報錯', () => {
    expect(validateProfile({ type: 'powershell', name: '  ' }, true)).toEqual([
      '儲存設定時必須填名稱',
    ]);
  });

  it('有名稱就通過', () => {
    expect(validateProfile({ type: 'powershell', name: '我的 PS' }, true)).toEqual([]);
  });

  it('不儲存時名稱仍然可以留空', () => {
    expect(validateProfile({ type: 'powershell' })).toEqual([]);
  });

  it('名稱的錯誤與類型本身的錯誤會一起回報', () => {
    expect(validateProfile({ type: 'ssh', host: '', user: 'u' }, true)).toEqual([
      '儲存設定時必須填名稱',
      '請輸入主機位址',
    ]);
  });
});
