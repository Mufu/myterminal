import { describe, it, expect, beforeEach } from 'vitest';
import { SessionLogger } from '../src/main/session-logger';
import type { ILogSink } from '../src/main/session-logger';

class FakeSink implements ILogSink {
  readonly chunks: string[] = [];
  closed = false;
  constructor(readonly path: string) {}
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  close(): void {
    this.closed = true;
  }
}

let sinks: FakeSink[];
let logger: SessionLogger;

beforeEach(() => {
  sinks = [];
  logger = new SessionLogger(
    'D:/logs',
    (path) => {
      const sink = new FakeSink(path);
      sinks.push(sink);
      return sink;
    },
    () => new Date(Date.UTC(2026, 8, 8, 1, 2, 3)),
  );
});

describe('SessionLogger', () => {
  it('start 用 <目錄>/<名稱>-<時間戳>.log 開檔並回傳路徑', () => {
    const path = logger.start('s1', 'PowerShell 1');
    expect(path).toBe('D:/logs/PowerShell 1-20260908-010203.log');
    expect(sinks[0].path).toBe(path);
  });

  it('檔名中不合法的字元會被換掉', () => {
    const path = logger.start('s1', 'ssh robert@a/b:c');
    expect(path).toBe('D:/logs/ssh robert@a_b_c-20260908-010203.log');
  });

  it('只有正在記錄的工作階段會被寫入 (Decorator 只包住被選中的資料流)', () => {
    logger.start('s1', 'A');
    logger.write('s1', 'hello');
    logger.write('s2', '不該被寫入');
    expect(sinks[0].chunks).toEqual(['hello']);
    expect(sinks).toHaveLength(1);
  });

  it('isLogging 反映目前狀態', () => {
    expect(logger.isLogging('s1')).toBe(false);
    logger.start('s1', 'A');
    expect(logger.isLogging('s1')).toBe(true);
    logger.stop('s1');
    expect(logger.isLogging('s1')).toBe(false);
  });

  it('stop 會關檔，之後的資料不再寫入', () => {
    logger.start('s1', 'A');
    logger.stop('s1');
    logger.write('s1', '停掉之後');
    expect(sinks[0].closed).toBe(true);
    expect(sinks[0].chunks).toEqual([]);
  });

  it('重複 start 不會開第二個檔', () => {
    const first = logger.start('s1', 'A');
    const second = logger.start('s1', 'A');
    expect(second).toBe(first);
    expect(sinks).toHaveLength(1);
  });

  it('stop 沒在記錄的工作階段不會丟例外', () => {
    expect(() => logger.stop('nope')).not.toThrow();
  });

  it('stopAll 關掉所有檔案', () => {
    logger.start('s1', 'A');
    logger.start('s2', 'B');
    logger.stopAll();
    expect(sinks.every((s) => s.closed)).toBe(true);
    expect(logger.isLogging('s1')).toBe(false);
  });
});
