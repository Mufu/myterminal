import { existsSync } from 'node:fs';
import type { ConnectionProfile, BaseShell } from '../shared/profile';
import { DEFAULT_SSH_PORT, defaultStartupCommand } from '../shared/profile';
import type { CliId } from '../shared/cli-auth';

/** 交給 pty 的 spawn 規格。*/
export interface SpawnSpec {
  file: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  /** spawn 之後要立刻寫進 pty 的指令 (Claude / Codex / Muse / OpenCode 用)。*/
  startupCommand?: string;
}

/**
 * 可執行檔解析器：DI 縫線。
 * 正式環境會去標準安裝路徑找，找不到就交給 OS 走 PATH；測試時注入假的。
 */
export type ExecutableResolver = (name: string) => string;

/** 某支 CLI 的工作階段要額外帶什麼進去。*/
export interface CliInjection {
  /** 疊在 process.env 上的環境變數 (「CLI 設定」選了 API 金鑰時才有東西)。*/
  env: Record<string, string>;
  /** 使用者沒改啟動指令時要用的那一條；目前只有 OpenCode 的 -m 會用到。*/
  startupCommand?: string;
  /** OpenCode 的 provider/model；無介面執行要拿它組 `opencode run -m …`。*/
  model?: string;
}

/**
 * 金鑰縫線：DI。ShellFactory 只問「這支 CLI 要帶什麼」，
 * 不知道金鑰存在哪裡、也不知道怎麼解密；測試注入假的。
 */
export type CliSecrets = (id: CliId, baseShell: BaseShell) => CliInjection;

const NO_SECRETS: CliSecrets = () => ({ env: {} });

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
 * WSLENV 是用冒號分隔的清單，決定哪些 Windows 環境變數會被帶進 WSL。
 * 直接覆寫會蓋掉使用者自己設的項目，所以是合併；已經有了就不重複加。
 */
export function mergeWslenv(current: string | undefined, added: string): string {
  const parts = (current ?? '').split(':').filter(Boolean);
  if (!parts.includes(added)) parts.push(added);
  return parts.join(':');
}

/**
 * ShellFactory — Factory Method。
 * 把純資料的 ConnectionProfile 轉成「要 spawn 什麼」的規格，
 * 所有跟後端種類有關的知識都集中在這裡；SessionManager 只認得 SpawnSpec。
 */
export class ShellFactory {
  constructor(
    private readonly resolve: ExecutableResolver = defaultResolver,
    private readonly secrets: CliSecrets = NO_SECRETS,
  ) {}

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
          // -no-antispoof：在 ConPTY 下 plink 會多印一行
          // "Access granted. Press Return to begin session."，並把使用者輸入的
          // 第一行整個吃掉當成那個 Return，關掉才能一登入就直接打字。
          args: [
            '-ssh',
            '-no-antispoof',
            '-P',
            String(profile.port ?? DEFAULT_SSH_PORT),
            `${profile.user}@${profile.host}`,
          ],
          cwd: profile.cwd,
          env: this.env(),
        };

      case 'claude':
      case 'codex':
      case 'muse':
      case 'opencode': {
        const injection = this.secrets(profile.type, profile.baseShell);
        const base = this.baseShell(profile.baseShell, profile.cwd, injection.env);
        const fallback = defaultStartupCommand(profile.type);
        const custom = profile.startupCommand?.trim();
        return {
          ...base,
          // 使用者自己改過啟動指令就照他的；沒改 (還是 CLI 的名字) 時才套
          // 「CLI 設定」算出來的那一條 (OpenCode 選了型號會變成 opencode -m …)。
          startupCommand:
            custom && custom !== fallback ? custom : (injection.startupCommand ?? fallback),
        };
      }

      // agent 任務不開 shell，由 SessionManager 直接交給 IAgentRunner。
      case 'agent':
        throw new Error('agent 任務不經過 ShellFactory');

      case 'custom':
        return {
          file: this.resolve(profile.file),
          args: profile.args ?? [],
          cwd: profile.cwd,
          env: this.env(),
        };
    }
  }

  private baseShell(shell: BaseShell, cwd?: string, injected?: Record<string, string>): SpawnSpec {
    return shell === 'wsl' ? this.wsl(undefined, cwd, injected) : this.powershell(cwd, injected);
  }

  private powershell(cwd?: string, injected?: Record<string, string>): SpawnSpec {
    return {
      file: this.resolve('powershell.exe'),
      args: ['-NoLogo'],
      cwd,
      env: this.env(injected),
    };
  }

  private wsl(distro?: string, cwd?: string, injected?: Record<string, string>): SpawnSpec {
    const args: string[] = [];
    if (distro) args.push('-d', distro);
    // cwd 交給 --cd：使用者填的通常是 Linux 路徑，拿去當 Windows 的 spawn cwd 會失敗。
    if (cwd) args.push('--cd', cwd);
    return { file: this.resolve('wsl.exe'), args, cwd: undefined, env: this.env(injected) };
  }

  private env(injected: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.TERM = 'xterm-256color';
    for (const [k, v] of Object.entries(injected)) {
      env[k] = k === 'WSLENV' ? mergeWslenv(env.WSLENV, v) : v;
    }
    return env;
  }
}
