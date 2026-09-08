import type { IPtyProcess, IPtySpawner } from '../../src/main/pty';
import type { SpawnSpec } from '../../src/main/shell-factory';

/** 測試替身：記錄所有互動，並可手動觸發 data / exit。*/
export class FakePty implements IPtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;

  private dataListener?: (data: string) => void;
  private exitListener?: (event: { exitCode: number }) => void;

  constructor(
    readonly spec: SpawnSpec,
    readonly cols: number,
    readonly rows: number,
  ) {}

  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }

  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exitListener = listener;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(): void {
    this.killed = true;
  }

  /** 測試用：模擬後端吐出資料。*/
  emitData(data: string): void {
    this.dataListener?.(data);
  }

  /** 測試用：模擬行程結束。*/
  emitExit(exitCode: number): void {
    this.exitListener?.({ exitCode });
  }
}

export class FakePtySpawner implements IPtySpawner {
  readonly spawned: FakePty[] = [];

  spawn(spec: SpawnSpec, cols: number, rows: number): IPtyProcess {
    const pty = new FakePty(spec, cols, rows);
    this.spawned.push(pty);
    return pty;
  }

  last(): FakePty {
    const pty = this.spawned.at(-1);
    if (!pty) throw new Error('還沒有 spawn 過任何 pty');
    return pty;
  }
}
