import { readFileSync, writeFileSync } from 'node:fs';
import { readPermission } from '../shared/agent';
import type { SavedProfile } from '../shared/profile';

/** 讀檔的縫線：回傳整個檔案內容，檔案不存在時回傳 null。*/
export type ProfileReader = () => string | null;
/** 寫檔的縫線：每次都覆寫整個檔案。*/
export type ProfileWriter = (content: string) => void;

/**
 * ProfileStore — 已儲存連線設定的 Repository。
 * 讀寫都透過注入的兩個函式，所以測試不碰真實檔案系統；
 * 檔案壞掉或不存在時一律當成空清單，不讓使用者的 app 因為一個 JSON 打不開。
 */
export class ProfileStore {
  constructor(
    private readonly read: ProfileReader,
    private readonly write: ProfileWriter,
  ) {}

  list(): SavedProfile[] {
    const raw = this.read();
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isSavedProfile).map(migrate) : [];
    } catch {
      return [];
    }
  }

  /** 以名稱 upsert (區分大小寫)；覆寫時保留原本的順序。*/
  save(profile: SavedProfile): void {
    const name = profile.name.trim();
    if (!name) throw new Error('連線設定必須有名稱');

    const profiles = this.list();
    const index = profiles.findIndex((p) => p.name === name);
    if (index >= 0) profiles[index] = { ...profile, name };
    else profiles.push({ ...profile, name });
    this.persist(profiles);
  }

  remove(name: string): void {
    this.persist(this.list().filter((p) => p.name !== name));
  }

  private persist(profiles: SavedProfile[]): void {
    this.write(`${JSON.stringify(profiles, null, 2)}\n`);
  }
}

/**
 * 舊檔案的 Agent 任務只有 allowEdits 兩檔，讀進來換成三檔的 permission；
 * 兩個欄位都沒有 (手改過的 JSON) 就給最保守的唯讀。
 */
function migrate(profile: SavedProfile): SavedProfile {
  if (profile.type !== 'agent') return profile;
  const next: SavedProfile & { allowEdits?: unknown } = { ...profile };
  next.permission = readPermission(next as unknown as Record<string, unknown>) ?? 'readonly';
  delete next.allowEdits;
  return next;
}

/** 手動編輯過的 JSON 也可能少欄位，缺名稱或類型的項目直接忽略。*/
function isSavedProfile(value: unknown): value is SavedProfile {
  if (typeof value !== 'object' || value === null) return false;
  const { name, type } = value as Partial<SavedProfile>;
  return typeof name === 'string' && name.trim() !== '' && typeof type === 'string';
}

/** 正式環境：整份檔案一次讀進來、一次覆寫回去。*/
export function fileProfileStore(path: string): ProfileStore {
  return new ProfileStore(
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
