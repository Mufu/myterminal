import { createWriteStream, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 一個已開啟的紀錄檔。實作可以是檔案串流，測試時是假的收集器。*/
export interface ILogSink {
  write(chunk: string): void;
  close(): void;
}

/** 開檔的縫線：正式環境開檔案串流，測試注入假的。*/
export type LogSinkFactory = (path: string) => ILogSink;

export const defaultLogDir = (): string => join(homedir(), 'myterminal-logs');

export const defaultSinkFactory: LogSinkFactory = (path) => {
  const stream = createWriteStream(path, { flags: 'a', encoding: 'utf8' });
  return {
    write: (chunk) => void stream.write(chunk),
    close: () => stream.end(),
  };
};

/** Windows 檔名不允許的字元。*/
const ILLEGAL = /[\\/:*?"<>|]/g;

function timestamp(now: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

/**
 * SessionLogger — 掛在 SessionManager 的 data 事件上的 Decorator/Observer。
 * 它不改變資料流，只是「順手」把被選中的工作階段輸出寫進檔案。
 * 開檔動作透過注入的 LogSinkFactory，所以測試不碰真實檔案系統。
 */
export class SessionLogger {
  private readonly sinks = new Map<string, ILogSink>();
  private readonly paths = new Map<string, string>();

  constructor(
    private readonly dir: string = defaultLogDir(),
    private readonly createSink: LogSinkFactory = defaultSinkFactory,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 開始記錄，回傳實際寫入的檔案路徑；已在記錄則直接回傳原路徑。*/
  start(sessionId: string, sessionName: string): string {
    const existing = this.paths.get(sessionId);
    if (existing) return existing;

    const safeName = sessionName.replace(ILLEGAL, '_');
    const path = `${this.dir}/${safeName}-${timestamp(this.now())}.log`;
    this.sinks.set(sessionId, this.createSink(path));
    this.paths.set(sessionId, path);
    return path;
  }

  stop(sessionId: string): void {
    this.sinks.get(sessionId)?.close();
    this.sinks.delete(sessionId);
    this.paths.delete(sessionId);
  }

  stopAll(): void {
    for (const id of [...this.sinks.keys()]) this.stop(id);
  }

  write(sessionId: string, chunk: string): void {
    this.sinks.get(sessionId)?.write(chunk);
  }

  isLogging(sessionId: string): boolean {
    return this.sinks.has(sessionId);
  }
}

/** 正式環境用：確保紀錄目錄存在。*/
export function ensureLogDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
