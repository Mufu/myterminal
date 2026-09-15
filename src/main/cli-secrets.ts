import type { ApiProvider, CliAuthSetting, CliId } from '../shared/cli-auth';
import type { BaseShell } from '../shared/profile';
import type { CliAuthStore } from './cli-auth-store';
import type { CliInjection, CliSecrets } from './shell-factory';

/**
 * OpenCode 的金鑰要放進哪個環境變數。這是 opencode 內建的 models.dev 註冊表裡
 * 那一家的 env 名稱；google 那家吃三個名字 (GOOGLE_API_KEY /
 * GOOGLE_GENERATIVE_AI_API_KEY / GEMINI_API_KEY)，但真正被 AI SDK 讀走的是
 * GOOGLE_GENERATIVE_AI_API_KEY，所以設這一個最保險。
 */
const PROVIDER_ENV: Record<ApiProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/** Windows 的環境變數不會自動進 WSL，要列在 WSLENV 裡才會被帶過去。*/
export const MUSE_WSLENV = 'META_API_KEY/u';

/**
 * 一支 CLI 的工作階段要帶什麼環境變數進去。
 *
 * 選「登入」時什麼都不注入 —— Muse 特別要注意 META_API_KEY 的優先度高過帳號
 * 登入，留著會變成「以為在用訂閱，其實在刷 API 帳單」。
 */
export function cliInjection(
  id: CliId,
  setting: CliAuthSetting,
  key: string | undefined,
  baseShell: BaseShell,
): CliInjection {
  const secret = setting.mode === 'apiKey' && key ? key : undefined;

  switch (id) {
    case 'claude':
      return { env: secret ? { ANTHROPIC_API_KEY: secret } : {} };

    case 'codex':
      // codex 0.142 直接讀 OPENAI_API_KEY，但 ~/.codex/auth.json 裡的 ChatGPT
      // 登入優先；要用金鑰的人得先 codex logout (README 有寫)。
      return { env: secret ? { OPENAI_API_KEY: secret } : {} };

    case 'muse': {
      if (!secret) return { env: {} };
      const env: Record<string, string> = { META_API_KEY: secret };
      // Windows 上是原生執行，環境變數直接就看得到；跑在 WSL 裡才需要 WSLENV。
      if (baseShell === 'wsl') env.WSLENV = MUSE_WSLENV;
      return { env };
    }

    case 'opencode': {
      const { provider } = setting;
      const name = setting.model?.trim();
      const model = provider && name ? `${provider}/${name}` : undefined;
      return {
        env: secret && provider ? { [PROVIDER_ENV[provider]]: secret } : {},
        startupCommand: model ? `opencode -m ${model}` : undefined,
        model,
      };
    }
  }
}

/** 正式環境的縫線：設定與金鑰都從 CliAuthStore 拿。*/
export function cliSecrets(store: CliAuthStore): CliSecrets {
  return (id, baseShell) => cliInjection(id, store.get(id), store.secretFor(id), baseShell);
}
