import { spawn } from 'node-pty';
import type { IPtyProcess, IPtySpawner } from './pty';
import type { SpawnSpec } from './shell-factory';

/**
 * node-pty 的正式 Adapter 實作。
 * 這是整個 main 行程唯一碰到 node-pty 的地方，
 * 因此其他邏輯都能以 FakePtySpawner 測試。
 */
export class NodePtySpawner implements IPtySpawner {
  spawn(spec: SpawnSpec, cols: number, rows: number): IPtyProcess {
    const pty = spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: spec.cwd,
      env: spec.env,
      useConpty: true,
    });

    return {
      onData: (listener) => void pty.onData(listener),
      onExit: (listener) => void pty.onExit(({ exitCode }) => listener({ exitCode })),
      write: (data) => pty.write(data),
      resize: (c, r) => pty.resize(c, r),
      kill: () => pty.kill(),
    };
  }
}
