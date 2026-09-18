/**
 * 角色：一段可以重複用的系統提示前言，加上一個預設的權限。
 * agent 節點與 Agent 任務都只存角色 id，真正的提示在這裡，
 * 改一次就全部生效。純資料，main 與 renderer 共用。
 *
 * 角色有兩種來源：內建的五個 (就寫在下面)，以及「角色庫」——
 * 使用者指一個資料夾，裡面每個有 frontmatter 的 markdown 就是一個角色。
 * 角色庫的角色 id 一律是 `lib:<相對路徑 (去掉 .md)>`，所以跟內建的撞不到。
 */

import type { AgentPermission } from './agent';

/**
 * 角色 id。內建的是下面那五個字串，角色庫的是 `lib:engineering/x`，
 * 使用者的資料夾長什麼樣我們事先不知道，所以型別上就是字串。
 */
export type AgentRole = string;

/** 內建那五個的 id，樣板 (workflow/templates.ts) 寫死用這些。*/
export type BuiltinRole = 'pm' | 'architect' | 'coder' | 'tester' | 'reviewer';

export interface RoleInfo {
  id: AgentRole;
  label: string;
  /** 送給 CLI 的前置指示：claude 走 --append-system-prompt，codex 接在提示前面。*/
  systemPrompt: string;
  /** 選了這個角色時「權限」的預設值；只有要動手的角色才給得到檔案。*/
  defaultPermission: AgentPermission;
  /** 內建的五個，還是從角色庫掃出來的。*/
  source: 'builtin' | 'library';
  /** 分類的顯示名稱；角色庫才有，內建的都歸在「內建」那一組。*/
  division?: string;
  /** 一行說明，角色選擇器上顯示。*/
  description?: string;
  emoji?: string;
}

/** 角色庫的 id 前綴；存進 JSON 的字串靠它認出「這個要去角色庫找」。*/
export const LIBRARY_ROLE_PREFIX = 'lib:';

export const isLibraryRole = (id: string): boolean => id.startsWith(LIBRARY_ROLE_PREFIX);

/** 內建那一組在選擇器上的組名。*/
export const BUILTIN_DIVISION = '內建';

/** 角色庫的檔案沒有分類 (直接躺在根目錄) 時歸在這一組。*/
export const UNSORTED_DIVISION = '未分類';

export const ROLES: readonly RoleInfo[] = [
  {
    id: 'pm',
    label: '產品經理',
    systemPrompt:
      '你是產品經理。把需求拆成一份可驗收的工作項目清單，每一項都要寫清楚完成的判準。' +
      '不明確的地方先問，不要自己假設。不要寫程式，也不要動任何檔案。',
    defaultPermission: 'readonly',
    source: 'builtin',
  },
  {
    id: 'architect',
    label: '架構師',
    systemPrompt:
      '你是架構師。設計模組邊界與介面，並說明每個決定的取捨與被你否決的替代方案。' +
      '只給介面與資料流，實作細節留給工程師。不要寫實作，也不要動任何檔案。',
    defaultPermission: 'readonly',
    source: 'builtin',
  },
  {
    id: 'coder',
    label: '工程師',
    systemPrompt:
      '你是工程師。依照指示實作，只碰跟這次需求有關的地方，不要順手改別的。' +
      '實作完要跑測試，沒過就修到過。最後摘要你改了哪些檔案、各改了什麼。',
    defaultPermission: 'edit',
    source: 'builtin',
  },
  {
    id: 'tester',
    label: '測試工程師',
    systemPrompt:
      '你是測試工程師。為這次的需求撰寫並執行測試，涵蓋正常路徑與邊界情況。' +
      '測試沒過時回報是哪一個測試、為什麼失敗，不要為了讓它變綠而改產品程式碼。' +
      '最後摘要跑了哪些測試與結果。',
    defaultPermission: 'edit',
    source: 'builtin',
  },
  {
    id: 'reviewer',
    label: '審查者',
    systemPrompt:
      '你是審查者。檢查變更有沒有完成需求，有沒有明顯的錯誤與遺漏。' +
      '只審查，不要修改任何檔案。逐項說明問題以及它在哪個檔案的哪一行。' +
      '最後一行只輸出 PASS 或 FAIL。',
    defaultPermission: 'readonly',
    source: 'builtin',
  },
];

/** 只找內建的五個。角色庫要用 findRoleIn，它得先被掃出來。*/
export function findRole(id: string): RoleInfo | undefined {
  return ROLES.find((role) => role.id === id);
}

/** 內建在前、角色庫在後。id 撞不到 (角色庫一律有 lib: 前綴)，所以不去重。*/
export function mergeRoles(
  builtin: readonly RoleInfo[],
  library: readonly RoleInfo[],
): RoleInfo[] {
  return [...builtin, ...library];
}

export function findRoleIn(roles: readonly RoleInfo[], id: string): RoleInfo | undefined {
  return roles.find((role) => role.id === id);
}

/** 選擇器上的搜尋：名稱、說明、分類、id 任一個包含就算中。*/
export function filterRoles(roles: readonly RoleInfo[], query: string): RoleInfo[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...roles];
  return roles.filter((role) =>
    [role.label, role.description ?? '', role.division ?? '', role.id].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

export interface RoleGroup {
  division: string;
  roles: RoleInfo[];
}

/** 選擇器上的分組：「內建」永遠第一組，其餘分類照名稱排。*/
export function groupRoles(roles: readonly RoleInfo[]): RoleGroup[] {
  const groups = new Map<string, RoleInfo[]>();
  for (const role of roles) {
    const division =
      role.source === 'builtin' ? BUILTIN_DIVISION : (role.division ?? UNSORTED_DIVISION);
    const bucket = groups.get(division);
    if (bucket) bucket.push(role);
    else groups.set(division, [role]);
  }

  const builtin = groups.get(BUILTIN_DIVISION);
  groups.delete(BUILTIN_DIVISION);
  const rest = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([division, list]) => ({ division, roles: list }));

  return builtin ? [{ division: BUILTIN_DIVISION, roles: builtin }, ...rest] : rest;
}

/** 選擇器與晶片上的寫法：有 emoji 就擺在名稱前面。*/
export function roleTagText(role: RoleInfo): string {
  return role.emoji ? `${role.emoji} ${role.label}` : role.label;
}
