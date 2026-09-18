import { readFileSync, writeFileSync } from 'node:fs';

/** 讀檔的縫線：回傳整個檔案內容，檔案不存在時回傳 null。*/
export type SettingsReader = () => string | null;
/** 寫檔的縫線：每次都覆寫整個檔案。*/
export type SettingsWriter = (content: string) => void;

/** 目前只有一項：角色庫的資料夾。沒設定過就是 undefined (用預設目錄)。*/
export interface Settings {
  rolesDir?: string;
}

/**
 * SettingsStore — 零散設定的 Repository，跟 ProfileStore 同一個手法：
 * 整份讀進來、整份寫回去，檔案壞掉或不存在時一律當成「什麼都還沒設定」。
 */
export class SettingsStore {
  constructor(
    private readonly read: SettingsReader,
    private readonly write: SettingsWriter,
  ) {}

  get(): Settings {
    const raw = this.read();
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      const { rolesDir } = parsed as Settings;
      return typeof rolesDir === 'string' && rolesDir.trim() ? { rolesDir } : {};
    } catch {
      return {};
    }
  }

  /** 空字串代表「回到預設目錄」。*/
  setRolesDir(dir: string): void {
    const rolesDir = dir.trim();
    this.write(`${JSON.stringify(rolesDir ? { rolesDir } : {}, null, 2)}\n`);
  }
}

/** 正式環境：整份檔案一次讀進來、一次覆寫回去。*/
export function fileSettingsStore(path: string): SettingsStore {
  return new SettingsStore(
    () => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    (content) => writeFileSync(path, content, 'utf8'),
  );
}
