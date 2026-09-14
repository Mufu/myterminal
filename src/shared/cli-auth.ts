/**
 * CLI 的登入方式。兩支 CLI 都可以用訂閱 (claude.ai / ChatGPT) 或 API 金鑰登入，
 * 而 total_cost_usd 只有後者才是真的帳單 —— 訂閱帳號那個數字是「API 等值」的估算，
 * 不另外收費，只算進方案的用量上限。金額要怎麼寫給人看，就看這裡判斷出來的 mode。
 */

export type BillingMode = 'subscription' | 'api' | 'unknown';

export interface CliAuth {
  loggedIn: boolean;
  mode: BillingMode;
  /** 訂閱的方案名稱，例如 max / ChatGPT。*/
  plan?: string;
  /** 給人看的描述，例如「Max 訂閱」「API 金鑰」「未登入」「找不到指令」。*/
  label: string;
}

export interface CliAuthStatus {
  claude: CliAuth;
  codex: CliAuth;
}

/** 判斷不出來的時候一律是這個 (探測失敗也共用)。*/
export const UNKNOWN_AUTH: CliAuth = { loggedIn: false, mode: 'unknown', label: '無法判斷' };

const NOT_LOGGED_IN: CliAuth = { loggedIn: false, mode: 'unknown', label: '未登入' };
const API_KEY: CliAuth = { loggedIn: true, mode: 'api', label: 'API 金鑰' };

/**
 * `claude auth status` 印一份 JSON：
 * {"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}
 * 用 API 金鑰登入時 authMethod 是 "apiKey"。
 */
export function parseClaudeAuth(stdout: string): CliAuth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return UNKNOWN_AUTH;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return UNKNOWN_AUTH;
  }

  const { loggedIn, authMethod, subscriptionType } = parsed as Record<string, unknown>;
  if (loggedIn !== true) return NOT_LOGGED_IN;
  if (authMethod === 'apiKey') return API_KEY;
  if (authMethod !== 'claude.ai') return { loggedIn: true, mode: 'unknown', label: '已登入' };

  const plan = typeof subscriptionType === 'string' ? subscriptionType : undefined;
  return {
    loggedIn: true,
    mode: 'subscription',
    plan,
    label: plan ? `${capitalize(plan)} 訂閱` : '訂閱',
  };
}

/** `codex login status` 只印一行。*/
export function parseCodexAuth(stdout: string): CliAuth {
  const text = stdout.trim();
  if (text.includes('Logged in using ChatGPT')) {
    return { loggedIn: true, mode: 'subscription', plan: 'ChatGPT', label: 'ChatGPT 訂閱' };
  }
  if (text.includes('Logged in using API key')) return API_KEY;
  if (text.includes('Not logged in')) return NOT_LOGGED_IN;
  return UNKNOWN_AUTH;
}

/** 金額三位小數 (一次 claude 呼叫大約 $0.09)；不是 API 帳單的就加上「≈」。*/
export function usageLabel(usd: number, mode: BillingMode): string {
  return `${mode === 'api' ? '' : '≈'}$${usd.toFixed(3)}`;
}

/** 金額旁邊的 tooltip：說清楚這個數字到底是不是錢。*/
export function usageTitle(mode: BillingMode): string {
  switch (mode) {
    case 'subscription':
      return 'CLI 依 token 用量估算的 API 等值金額，訂閱帳號不另收費，只算進方案的用量上限';
    case 'api':
      return '這次執行的 API 費用';
    case 'unknown':
      return '估算金額，實際是否收費取決於 CLI 的登入方式';
  }
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
