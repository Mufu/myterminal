import type { IChildProcess, IProcessSpawner, ProcessSpec } from '../../src/main/process-spawner';

/** 測試替身：記下 spawn 規格，並可手動餵 stdout / stderr / exit。*/
export class FakeChildProcess implements IChildProcess {
  killed = false;
  private stdout?: (chunk: string) => void;
  private stderr?: (chunk: string) => void;
  private exit?: (exitCode: number) => void;

  constructor(readonly spec: ProcessSpec) {}

  onStdout(listener: (chunk: string) => void): void {
    this.stdout = listener;
  }

  onStderr(listener: (chunk: string) => void): void {
    this.stderr = listener;
  }

  onExit(listener: (exitCode: number) => void): void {
    this.exit = listener;
  }

  kill(): void {
    this.killed = true;
  }

  emitStdout(chunk: string): void {
    this.stdout?.(chunk);
  }

  emitStderr(chunk: string): void {
    this.stderr?.(chunk);
  }

  emitExit(exitCode: number): void {
    this.exit?.(exitCode);
  }
}

export class FakeProcessSpawner implements IProcessSpawner {
  readonly spawned: FakeChildProcess[] = [];

  spawn(spec: ProcessSpec): IChildProcess {
    const child = new FakeChildProcess(spec);
    this.spawned.push(child);
    return child;
  }

  last(): FakeChildProcess {
    const child = this.spawned.at(-1);
    if (!child) throw new Error('還沒有 spawn 過任何行程');
    return child;
  }
}
