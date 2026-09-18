import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RoleInfo, SkippedRoleFile } from '../shared/roles';
import { ROLES, mergeRoles } from '../shared/roles';
import { parseDivisions, parseRoleFile } from '../shared/role-file';
import type { RolesResult } from '../shared/ipc';
import type { SettingsStore } from './settings-store';

/** 掃資料夾的縫線：底下所有 markdown 的相對路徑與內容。目錄不存在時回空陣列。*/
export type ListMarkdown = (dir: string) => MarkdownFile[];
/** 讀 divisions.json 的縫線：不存在時回 null。*/
export type ReadDivisions = (dir: string) => string | null;

export interface MarkdownFile {
  /** 相對於角色庫根目錄的路徑，例如 engineering/code-reviewer.md。*/
  relPath: string;
  text: string;
}

export interface RoleScan {
  roles: RoleInfo[];
  skipped: SkippedRoleFile[];
  /** 這次掃的是哪個資料夾。*/
  dir: string;
  scannedAt: number;
}

/**
 * 不是角色的資料夾。上游 (agency-agents) 拿這幾個放轉換輸出、劇本與腳本，
 * 裡面的 markdown 沒有 frontmatter 或不是角色，掃進來只會洗版。
 */
const NON_ROLE_DIRS: readonly string[] = ['integrations', 'strategy', 'examples', 'scripts'];

/**
 * RoleLibrary — 角色庫的 Repository。
 * 跟 ProfileStore 一樣，碰檔案系統的部分全部走注入的縫線，
 * 所以掃描規則可以在沒有真實資料夾的情況下被測試。
 *
 * 任何一個檔案壞掉都不會丟例外 —— 讀不出角色的就記進 skipped，
 * 使用者指到一個亂七八糟的資料夾時 app 還是活著的。
 */
export class RoleLibrary {
  private last: RoleScan | null = null;

  constructor(
    private readonly listMarkdown: ListMarkdown,
    private readonly readDivisions: ReadDivisions,
    private readonly now: () => number = Date.now,
  ) {}

  /** 掃過同一個資料夾就直接給上次的結果；要重讀請用 rescan。*/
  scan(dir: string): RoleScan {
    if (this.last && this.last.dir === dir) return this.last;
    return this.rescan(dir);
  }

  rescan(dir: string): RoleScan {
    const divisions = parseDivisions(this.readDivisions(dir) ?? '');
    const roles: RoleInfo[] = [];
    const skipped: SkippedRoleFile[] = [];

    for (const file of this.listMarkdown(dir)) {
      const relPath = file.relPath.replace(/\\/g, '/');
      const top = relPath.includes('/') ? relPath.split('/')[0] : '';
      if (top.startsWith('.') || NON_ROLE_DIRS.includes(top)) {
        skipped.push({ relPath, reason: '不是角色資料夾' });
        continue;
      }
      const role = parseRoleFile(relPath, file.text, divisions);
      if (role) roles.push(role);
      else skipped.push({ relPath, reason: '沒有 frontmatter 的 name' });
    }

    this.last = { roles, skipped, dir, scannedAt: this.now() };
    return this.last;
  }
}

/**
 * main 這一側查角色的縫線：內建五個 + 角色庫掃出來的那一份。
 * graph-compiler 與 SessionManager 都只透過它找角色，
 * 測試就不必為了一個 systemPrompt 去準備一個資料夾。
 */
export type RoleRegistry = () => readonly RoleInfo[];

/** 沒有角色庫的時候 (以及大部分的單元測試) 就只有內建那五個。*/
export const builtinRegistry: RoleRegistry = () => ROLES;

/** 把一次掃描的結果接成 registry 要的那份完整清單。*/
export function rolesOf(scan: RoleScan): RoleInfo[] {
  return mergeRoles(ROLES, scan.roles);
}

/**
 * RoleService — 把「設定裡的資料夾」與「掃出來的角色」黏在一起，
 * 就是 roles:list / roles:rescan / roles:set-dir 這三個頻道的內容。
 * IPC 那一層只負責轉接，所以規則在這裡測得到。
 */
export class RoleService {
  constructor(
    private readonly library: RoleLibrary,
    private readonly settings: SettingsStore,
    /** 沒設定過角色資料夾時用的預設 (userData/roles)。*/
    private readonly defaultDir: string,
    /** 目錄存不存在的縫線，測試注入假的。*/
    private readonly exists: (path: string) => boolean = existsSync,
  ) {}

  dir(): string {
    return this.settings.get().rolesDir ?? this.defaultDir;
  }

  /** 掃過就給快取的那一份。*/
  list(): RolesResult {
    return this.result(this.library.scan(this.dir()));
  }

  rescan(): RolesResult {
    return this.result(this.library.rescan(this.dir()));
  }

  /** 換資料夾：目錄不存在就整個不動，連設定都不寫。*/
  setDir(dir: string): RolesResult {
    const wanted = dir.trim();
    if (!wanted) throw new Error('請輸入角色資料夾');
    if (!this.exists(wanted)) throw new Error(`角色資料夾不存在：${wanted}`);
    this.settings.setRolesDir(wanted);
    return this.rescan();
  }

  /** 交給 SessionManager 與編排層查角色用的那個縫線。*/
  registry: RoleRegistry = () => rolesOf(this.library.scan(this.dir()));

  private result(scan: RoleScan): RolesResult {
    return {
      roles: rolesOf(scan),
      dir: scan.dir,
      skipped: scan.skipped,
      scannedAt: scan.scannedAt,
    };
  }
}

/** 正式環境：真的走一遍資料夾。讀不到的檔案直接跳過，不讓一顆權限錯誤炸掉掃描。*/
export function fileRoleLibrary(): RoleLibrary {
  return new RoleLibrary(
    (dir) => {
      const out: MarkdownFile[] = [];
      walk(dir, '', out);
      return out;
    },
    (dir) => {
      try {
        return readFileSync(join(dir, 'divisions.json'), 'utf8');
      } catch {
        return null;
      }
    },
  );
}

function walk(dir: string, prefix: string, out: MarkdownFile[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 資料夾不存在 (預設那個一開始就沒建) 就是沒有角色，不是錯誤。
    return;
  }
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    // .git 底下有成千上萬個檔案，走進去只是白花時間。
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      walk(join(dir, entry.name), relPath, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    try {
      out.push({ relPath, text: readFileSync(join(dir, entry.name), 'utf8') });
    } catch {
      // 讀不到就當它不存在。
    }
  }
}
