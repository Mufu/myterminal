import type { CliSessionType, ConnectionProfile } from './profile';
import { CLI_TYPES, TYPE_LABELS } from './profile';

/**
 * CLI 的登入方式。四支 CLI 都可以用訂閱 (claude.ai / ChatGPT / Meta 帳號) 或 API 金鑰登入，
 * 而 total_cost_usd 只有後者才是真的帳單 —— 訂閱帳號那個數字是「API 等值」的估算，
 * 不另外收費，只算進方案的用量上限。金額要怎麼寫給人看，就看這裡判斷出來的 mode。
 */

export type BillingMode = 'subscription' | 'api' | 'unknown';

/** 「CLI 設定」管的四支 CLI；跟互動式工作階段的型別是同一組。*/
export type CliId = CliSessionType;
export const CLI_IDS = CLI_TYPES;

/** 使用者為某支 CLI 選的登入方式。*/
export type AuthMode = 'login' | 'apiKey';

/** OpenCode 的金鑰要放進哪一家的環境變數。*/
export type ApiProvider = 'anthropic' | 'openai' | 'google' | 'openrouter';

export const API_PROVIDERS: readonly { id: ApiProvider; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google' },
  { id: 'openrouter', label: 'OpenRouter' },
];

/**
 * OpenCode 沒有自己的登入流程 (`opencode auth list` 只認 API 金鑰)，
 * 所以那一列只給金鑰，不給「登入」。
 */
export const CLI_SUPPORTS_LOGIN: Record<CliId, boolean> = {
  claude: true,
  codex: true,
  muse: true,
  opencode: false,
};

export const defaultCliMode = (id: CliId): AuthMode =>
  CLI_SUPPORTS_LOGIN[id] ? 'login' : 'apiKey';

/** 一支 CLI 的設定。金鑰本身永遠留在 main，renderer 只知道存了沒有。*/
export interface CliAuthSetting {
  mode: AuthMode;
  hasKey: boolean;
  /** 只有 OpenCode 用得到：金鑰是哪一家的。*/
  provider?: ApiProvider;
  /** 只有 OpenCode 用得到：`opencode -m <provider>/<model>`。*/
  model?: string;
}

/** 按「登入」時要跑的指令；OpenCode 沒有。*/
const LOGIN_COMMANDS: Record<CliId, string> = {
  claude: 'claude auth login',
  codex: 'codex login',
  muse: 'muse login',
  opencode: '',
};

/**
 * 「登入」開出來的就是一個普通的互動式工作階段 ——
 * 瀏覽器那一段流程由使用者自己在裡面走完，結束之後 main 再探一次登入狀態。
 */
export function loginProfile(id: CliId): ConnectionProfile {
  if (!CLI_SUPPORTS_LOGIN[id]) throw new Error(`${TYPE_LABELS[id]} 只能使用 API 金鑰`);
  return {
    type: id,
    name: `${TYPE_LABELS[id]} 登入`,
    baseShell: 'powershell',
    startupCommand: LOGIN_COMMANDS[id],
  };
}

/** 存檔前的驗證；跟 validateProfile 一樣回傳訊息陣列，空陣列代表合法。*/
export function validateCliSetting(
  setting: { id: CliId; mode: AuthMode; apiKey?: string; provider?: ApiProvider },
  hasKey: boolean,
): string[] {
  const errors: string[] = [];
  if (setting.mode === 'login' && !CLI_SUPPORTS_LOGIN[setting.id]) {
    errors.push(`${TYPE_LABELS[setting.id]} 只能使用 API 金鑰`);
  }
  if (setting.mode === 'apiKey' && !setting.apiKey?.trim() && !hasKey) {
    errors.push('請輸入 API 金鑰');
  }
  if (setting.id === 'opencode' && setting.mode === 'apiKey' && !setting.provider) {
    errors.push('請選擇供應商');
  }
  return errors;
}

export interface CliAuth {
  loggedIn: boolean;
  mode: BillingMode;
  /** 訂閱的方案名稱，例如 max / ChatGPT。*/
  plan?: string;
  /** 給人看的描述，例如「Max 訂閱」「API 金鑰」「未登入」「找不到指令」。*/
  label: string;
}

export type CliAuthStatus = Record<CliId, CliAuth>;

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

/**
 * Muse 沒有 `muse auth status`，所以看的是它存憑證的檔案：
 * Windows 是 %USERPROFILE%/.config/muse/auth.json，WSL 是 ~/.config/muse/auth.json。
 * `muse logout` 之後檔案還在、providers 會變成空的，所以不能只看檔案在不在。
 * 收的是整份 JSON，但只判斷「有沒有 meta」與「是不是 api_key」，金鑰不會被取出來。
 * 檔案不存在 (從沒登入過) 時傳 null。
 */
export function parseMuseAuth(content: string | null): CliAuth {
  if (content === null) return NOT_LOGGED_IN;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return UNKNOWN_AUTH;
  }
  const providers = (parsed as { providers?: unknown })?.providers;
  if (typeof providers !== 'object' || providers === null) return UNKNOWN_AUTH;
  const meta = (providers as Record<string, unknown>).meta;
  if (typeof meta !== 'object' || meta === null) return NOT_LOGGED_IN;
  return 'api_key' in meta
    ? API_KEY
    : { loggedIn: true, mode: 'subscription', plan: 'Meta', label: 'Meta 帳號' };
}

/**
 * `opencode auth list` 最後一行是「N credentials」(前面有顏色跳脫序列)。
 * 它自己沒存憑證時，app 若有替它存一把金鑰，注入環境變數之後一樣跑得起來。
 */
export function parseOpencodeAuth(stdout: string, hasStoredKey = false): CliAuth {
  const match = /(\d+)\s+credentials?/.exec(stdout);
  if (!match) return UNKNOWN_AUTH;
  if (Number(match[1]) > 0) return API_KEY;
  return hasStoredKey ? API_KEY : NOT_LOGGED_IN;
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
