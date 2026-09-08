import { spawn } from 'node-pty';
import type { IPtyProcess, IPtySpawner } from './pty';
import type { SpawnSpec } from './shell-factory';

/**
 * node-pty 的正式 Adapter 實作。
 * 這是整個 main 行程唯一碰到 node-pty 的地方，
 * 因此其他邏輯都能以 FakePtySpawner 測試。
 *
 * node-pty 的 Windows 後端會在「行程已結束」時丟例外
 * (resize / write / kill)，而且有些是從非同步回呼裡丟出來的，
 * ipcMain.handle 攔不到，會變成主行程的錯誤對話框。
 * 所以這一層自己記住 exited 狀態並把例外吞掉。
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

    let exited = false;
    const guard = (what: string, action: () => void): void => {
      if (exited) return;
      try {
        action();
      } catch (error) {
        console.error(`[pty] ${what} 失敗:`, error);
      }
    };

    return {
      onData: (listener) => void pty.onData(listener),
      onExit: (listener) =>
        void pty.onExit(({ exitCode }) => {
          exited = true;
          listener({ exitCode });
        }),
      write: (data) => guard('write', () => pty.write(data)),
      resize: (c, r) => guard('resize', () => pty.resize(c, r)),
      kill: () => guard('kill', () => pty.kill()),
    };
  }
}
