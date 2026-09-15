import { describe, it, expect } from 'vitest';
import { nodeDotClass, runStatusLabel, usageMode } from '../src/renderer/workflow-list-view';
import { parseBudget, validateRunParams } from '../src/renderer/workflow-run-dialog';
import type { RunNodeStatus, RunStatus } from '../src/shared/workflow';
import type { CliAuthStatus } from '../src/shared/cli-auth';
import { ROLES, findRole } from '../src/shared/roles';

describe('runStatusLabel', () => {
  it('每個狀態都有中文名稱', () => {
    const labels: Record<RunStatus, string> = {
      running: '執行中',
      waiting_approval: '等待批准',
      done: '完成',
      failed: '失敗',
      cancelled: '已取消',
      rejected: '已退回',
    };
    for (const [status, label] of Object.entries(labels)) {
      expect(runStatusLabel(status as RunStatus)).toBe(label);
    }
  });
});

describe('nodeDotClass', () => {
  it('沿用 .session-dot，還沒輪到的沒有修飾類別', () => {
    expect(nodeDotClass('idle')).toBe('session-dot');
  });

  it('其他狀態各自加一個修飾類別', () => {
    const statuses: RunNodeStatus[] = [
      'running',
      'done',
      'failed',
      'waiting',
      'skipped',
      'cancelled',
    ];
    for (const status of statuses) expect(nodeDotClass(status)).toBe(`session-dot ${status}`);
  });
});

describe('usageMode', () => {
  const auth: CliAuthStatus = {
    claude: { loggedIn: true, mode: 'subscription', label: 'Max 訂閱' },
    codex: { loggedIn: true, mode: 'api', label: 'API 金鑰' },
    muse: { loggedIn: false, mode: 'unknown', label: '未登入' },
    opencode: { loggedIn: false, mode: 'unknown', label: '未登入' },
  };

  it('節點看自己那一支 CLI，執行總額看 claude', () => {
    expect(usageMode(auth, 'claude')).toBe('subscription');
    expect(usageMode(auth, 'codex')).toBe('api');
    expect(usageMode(auth)).toBe('subscription');
  });

  it('還沒探測回來的時候一律當成不確定', () => {
    expect(usageMode(null)).toBe('unknown');
    expect(usageMode(null, 'codex')).toBe('unknown');
  });
});

describe('parseBudget', () => {
  it('留空、零或看不懂的字都是不限制', () => {
    expect(parseBudget('')).toBeUndefined();
    expect(parseBudget('  ')).toBeUndefined();
    expect(parseBudget('0')).toBeUndefined();
    expect(parseBudget('-1')).toBeUndefined();
    expect(parseBudget('兩塊')).toBeUndefined();
  });

  it('填了正數就是上限', () => {
    expect(parseBudget('2')).toBe(2);
    expect(parseBudget(' 0.5 ')).toBe(0.5);
  });
});

describe('validateRunParams', () => {
  it('任務與工作目錄都是必填的', () => {
    expect(validateRunParams({ task: '建立 hello.txt', cwd: 'D:/tmp' })).toEqual([]);
    expect(validateRunParams({ task: '  ', cwd: 'D:/tmp' })).toEqual(['請輸入任務內容']);
    expect(validateRunParams({ task: 'x', cwd: '' })).toEqual(['請輸入工作目錄']);
    expect(validateRunParams({ task: '', cwd: '' })).toEqual(['請輸入任務內容', '請輸入工作目錄']);
  });
});

/** 節點列上的角色標籤就是 ROLES 的 label，所以測的是這一份清單。*/
describe('ROLES', () => {
  it('順序固定，每個角色都有中文標籤', () => {
    expect(ROLES.map((role) => role.id)).toEqual(['pm', 'architect', 'coder', 'tester', 'reviewer']);
    expect(ROLES.map((role) => role.label)).toEqual([
      '產品經理',
      '架構師',
      '工程師',
      '測試工程師',
      '審查者',
    ]);
  });

  it('只有要動手的角色預設允許修改檔案', () => {
    expect(ROLES.filter((role) => role.defaultAllowEdits).map((role) => role.id)).toEqual([
      'coder',
      'tester',
    ]);
  });

  it('findRole 找不到的角色是 undefined', () => {
    expect(findRole('reviewer')?.systemPrompt).toContain('PASS 或 FAIL');
    expect(findRole('boss')).toBeUndefined();
  });
});
