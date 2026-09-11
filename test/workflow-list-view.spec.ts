import { describe, it, expect } from 'vitest';
import { nodeDotClass, runStatusLabel } from '../src/renderer/workflow-list-view';
import { validateRunParams } from '../src/renderer/workflow-run-dialog';
import type { RunNodeStatus, RunStatus } from '../src/shared/workflow';

describe('runStatusLabel', () => {
  it('每個狀態都有中文名稱', () => {
    const labels: Record<RunStatus, string> = {
      running: '執行中',
      waiting_approval: '等待批准',
      done: '完成',
      failed: '失敗',
      cancelled: '已取消',
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
    const statuses: RunNodeStatus[] = ['running', 'done', 'failed', 'waiting', 'skipped'];
    for (const status of statuses) expect(nodeDotClass(status)).toBe(`session-dot ${status}`);
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
