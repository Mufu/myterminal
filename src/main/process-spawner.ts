import { spawn } from 'node:child_process';

/** 交給 IProcessSpawner 的規格。*/
export interface ProcessSpec {
  file: string;
  args: string[];
  cwd: string;
  /** 寫進 stdin 之後立刻關閉；提示走 stdin 就不必處理引號與換行。*/
  stdin?: string;
}

export interface IChildProcess {
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  kill(): void;
}

/**
 * child_process 的 Adapter 介面。
 * AgentRunner 只認得這個介面，所以解析器可以用 FakeProcessSpawner 測，
 * 完全不用真的呼叫 (要付費的) CLI。
 */
export interface IProcessSpawner {
  spawn(spec: ProcessSpec): IChildProcess;
}

/**
 * 正式實作。這是 agent 這條路徑上唯一碰到 child_process 的地方。
 *
 * Windows 注意：`codex` 是 %APPDATA%\npm\codex.cmd 這個 shim，
 * Node 不允許直接 spawn .cmd (EINVAL)，不經 shell 直接用 "codex" 則是 ENOENT。
 * 所以 CodexRunner 送進來的是 cmd.exe /c codex …；這一層不需要知道這件事。
 */
export class NodeProcessSpawner implements IProcessSpawner {
  spawn(spec: ProcessSpec): IChildProcess {
    const child = spawn(spec.file, spec.args, { cwd: spec.cwd, windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdin.end(spec.stdin ?? '', 'utf8');

    let exited = false;
    let onExit: ((exitCode: number) => void) | undefined;
    let onStderr: ((chunk: string) => void) | undefined;
    const finish = (code: number): void => {
      if (exited) return;
      exited = true;
      onExit?.(code);
    };

    // spawn 失敗 (例如找不到執行檔) 只會有 error，不一定會有 close。
    child.on('error', (error) => {
      onStderr?.(String(error.message));
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? 0));

    return {
      onStdout: (listener) => void child.stdout.on('data', listener),
      onStderr: (listener) => {
        onStderr = listener;
        child.stderr.on('data', listener);
      },
      onExit: (listener) => void (onExit = listener),
      kill: () => {
        if (!exited) child.kill();
      },
    };
  }
}
