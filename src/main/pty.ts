import type { SpawnSpec } from './shell-factory';

/**
 * node-pty 的 Adapter 介面。
 * SessionManager 只認得這兩個介面，所以單元測試可以注入 FakePtySpawner，
 * 完全不用真的開一個 shell。正式環境的實作在 node-pty-spawner.ts。
 */
export interface IPtyProcess {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface IPtySpawner {
  spawn(spec: SpawnSpec, cols: number, rows: number): IPtyProcess;
}
