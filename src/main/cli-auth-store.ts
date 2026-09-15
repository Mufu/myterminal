import { readFileSync, writeFileSync } from 'node:fs';
import type { ApiProvider, AuthMode, CliAuthSetting, CliId } from '../shared/cli-auth';
import { CLI_IDS, defaultCliMode } from '../shared/cli-auth';

/** 讀檔的縫線：回傳整個檔案內容，檔案不存在時回傳 null。*/
export type CliAuthReader = () => string | null;
/** 寫檔的縫線：每次都覆寫整個檔案。*/
export type CliAuthWriter = (content: string) => void;

/**
 * 加解密的縫線。正式環境是 Electron 的 safeStorage (Windows 上就是 DPAPI，
 * 綁這台機器的這個使用者)，測試注入假的，所以驗證邏輯不必真的加密。
 */
export interface Cipher {
  encrypt(plain: string): string;
  decrypt(secret: string): string;
}

/** 檔案裡的一列。key 是加密後的 base64，任何時候都不會有明文。*/
interface StoredSetting {
  mode: AuthMode;
  key?: string;
  provider?: ApiProvider;
  model?: string;
}

/** set() 收的東西；apiKey 留空代表沿用已經存著的那一把。*/
export interface CliAuthInput {
  mode: AuthMode;
  apiKey?: string;
  provider?: ApiProvider;
  model?: string;
}

/**
 * CliAuthStore — 「CLI 設定」的 Repository。
 * 跟 ProfileStore 一樣整份讀進來、整份寫回去；檔案壞掉或不存在時一律當成
 * 「四支 CLI 都還沒設定過」，不讓一個 JSON 把 app 卡死。
 * 金鑰只在 secretFor() 裡被解開，不進 log 也不進 IPC。
 */
export class CliAuthStore {
  constructor(
    private readonly read: CliAuthReader,
    private readonly write: CliAuthWriter,
    private readonly cipher: Cipher,
  ) {}

  /** 四支 CLI 各一列，沒設定過的就是預設值。*/
  settings(): Record<CliId, CliAuthSetting> {
    const stored = this.load();
    const out = {} as Record<CliId, CliAuthSetting>;
    for (const id of CLI_IDS) out[id] = toSetting(id, stored[id]);
    return out;
  }

  get(id: CliId): CliAuthSetting {
    return toSetting(id, this.load()[id]);
  }

  set(id: CliId, input: CliAuthInput): void {
    const stored = this.load();
    const current = stored[id];
    const key = input.apiKey?.trim();
    stored[id] = {
      mode: input.mode,
      // 沒重打金鑰就沿用舊的 —— 畫面上那一格顯示的是「已儲存」。
      key: key ? this.cipher.encrypt(key) : current?.key,
      provider: input.provider ?? current?.provider,
      model: input.model === undefined ? current?.model : input.model.trim() || undefined,
    };
    this.persist(stored);
  }

  clearKey(id: CliId): void {
    const stored = this.load();
    const current = stored[id];
    if (!current?.key) return;
    stored[id] = { ...current, key: undefined };
    this.persist(stored);
  }

  /**
   * 要注入環境變數時才把金鑰解開。只有選了「API 金鑰」的那一支才給；
   * 解不開 (例如設定檔被搬到別台機器) 就當成沒有，不要讓工作階段開不起來。
   */
  secretFor(id: CliId): string | undefined {
    const stored = this.load()[id];
    if (!stored?.key || stored.mode !== 'apiKey') return undefined;
    try {
      return this.cipher.decrypt(stored.key) || undefined;
    } catch {
      return undefined;
    }
  }

  private load(): Partial<Record<CliId, StoredSetting>> {
    const raw = this.read();
    if (!raw) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (typeof parsed !== 'object' || parsed === null) return {};

    const out: Partial<Record<CliId, StoredSetting>> = {};
    for (const id of CLI_IDS) {
      const value = (parsed as Record<string, unknown>)[id];
      if (isStored(value)) out[id] = value;
    }
    return out;
  }

  private persist(stored: Partial<Record<CliId, StoredSetting>>): void {
    this.write(`${JSON.stringify(stored, null, 2)}\n`);
  }
}

function toSetting(id: CliId, stored: StoredSetting | undefined): CliAuthSetting {
  const setting: CliAuthSetting = {
    mode: stored?.mode ?? defaultCliMode(id),
    hasKey: Boolean(stored?.key),
  };
  if (stored?.provider) setting.provider = stored.provider;
  if (stored?.model) setting.model = stored.model;
  return setting;
}

/** 手動編輯過的 JSON 也可能少欄位；沒有合法 mode 的那一列直接忽略。*/
function isStored(value: unknown): value is StoredSetting {
  if (typeof value !== 'object' || value === null) return false;
  const { mode } = value as Partial<StoredSetting>;
  return mode === 'login' || mode === 'apiKey';
}

/** 正式環境：整份檔案一次讀進來、一次覆寫回去。*/
export function fileCliAuthStore(path: string, cipher: Cipher): CliAuthStore {
  return new CliAuthStore(
    () => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    (content) => writeFileSync(path, content, 'utf8'),
    cipher,
  );
}
