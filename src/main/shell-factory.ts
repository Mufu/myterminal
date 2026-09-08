import { existsSync } from 'node:fs';
import type { ConnectionProfile, BaseShell } from '../shared/profile';
import { DEFAULT_SSH_PORT, defaultStartupCommand } from '../shared/profile';

/** 交給 pty 的 spawn 規格。*/
export interface SpawnSpec {
  file: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  /** spawn 之後要立刻寫進 pty 的指令 (Claude / Codex 用)。*/
  startupCommand?: string;
}

/**
 * 可執行檔解析器：DI 縫線。
 * 正式環境會去標準安裝路徑找，找不到就交給 OS 走 PATH；測試時注入假的。
 */
export type ExecutableResolver = (name: string) => string;

/** 各個後端的標準安裝位置。找不到時回傳原名，讓 PATH 決定。*/
const STANDARD_LOCATIONS: Record<string, string[]> = {
  'wsl.exe': ['C:/Windows/System32/wsl.exe'],
  'plink.exe': ['C:/Program Files/PuTTY/plink.exe', 'C:/Program Files (x86)/PuTTY/plink.exe'],
};

export const defaultResolver: ExecutableResolver = (name) => {
  const candidates = STANDARD_LOCATIONS[name] ?? [];
  return candidates.find((p) => existsSync(p)) ?? name;
};

/**
 * ShellFactory — Factory Method。
 * 把純資料的 ConnectionProfile 轉成「要 spawn 什麼」的規格，
 * 所有跟後端種類有關的知識都集中在這裡；SessionManager 只認得 SpawnSpec。
 */
export class ShellFactory {
  constructor(private readonly resolve: ExecutableResolver = defaultResolver) {}

  create(profile: ConnectionProfile): SpawnSpec {
    switch (profile.type) {
      case 'powershell':
        return this.powershell(profile.cwd);

      case 'wsl':
        return this.wsl(profile.distro, profile.cwd);

      case 'ssh':
        return {
          file: this.resolve('plink.exe'),
          // 刻意不加 -batch：主機金鑰確認等提示要能顯示在終端機裡讓使用者回答。
          args: [
            '-ssh',
            '-P',
            String(profile.port ?? DEFAULT_SSH_PORT),
            `${profile.user}@${profile.host}`,
          ],
          cwd: profile.cwd,
          env: this.env(),
        };

      case 'claude':
      case 'codex': {
        const base = this.baseShell(profile.baseShell, profile.cwd);
        return {
          ...base,
          startupCommand: profile.startupCommand ?? defaultStartupCommand(profile.type),
        };
      }

      case 'custom':
        return {
          file: this.resolve(profile.file),
          args: profile.args ?? [],
          cwd: profile.cwd,
          env: this.env(),
        };
    }
  }

  private baseShell(shell: BaseShell, cwd?: string): SpawnSpec {
    return shell === 'wsl' ? this.wsl(undefined, cwd) : this.powershell(cwd);
  }

  private powershell(cwd?: string): SpawnSpec {
    return {
      file: this.resolve('powershell.exe'),
      args: ['-NoLogo'],
      cwd,
      env: this.env(),
    };
  }

  private wsl(distro?: string, cwd?: string): SpawnSpec {
    const args: string[] = [];
    if (distro) args.push('-d', distro);
    // cwd 交給 --cd：使用者填的通常是 Linux 路徑，拿去當 Windows 的 spawn cwd 會失敗。
    if (cwd) args.push('--cd', cwd);
    return { file: this.resolve('wsl.exe'), args, cwd: undefined, env: this.env() };
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.TERM = 'xterm-256color';
    return env;
  }
}
