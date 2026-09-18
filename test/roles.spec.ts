import { describe, it, expect } from 'vitest';
import type { RoleInfo } from '../src/shared/roles';
import {
  ROLES,
  filterRoles,
  findRole,
  findRoleIn,
  groupRoles,
  isLibraryRole,
  mergeRoles,
  roleTagText,
} from '../src/shared/roles';

/** 角色庫掃出來的一個角色；只有這幾個欄位在下面的規則裡有作用。*/
const lib = (id: string, label: string, extra: Partial<RoleInfo> = {}): RoleInfo => ({
  id: `lib:${id}`,
  label,
  systemPrompt: '你是…',
  defaultPermission: 'readonly',
  source: 'library',
  ...extra,
});

const reviewer = lib('engineering/code-reviewer', 'Code Reviewer', {
  division: 'Engineering',
  description: 'Reviews code like a mentor',
  emoji: '👁️',
});
const tester = lib('testing/api-tester', 'API Tester', { division: 'Testing' });
const loose = lib('solo', 'Solo');

describe('內建角色', () => {
  it('五個 id 與標籤沒變，存進 JSON 的舊設定才還讀得到', () => {
    expect(ROLES.map((role) => role.id)).toEqual(['pm', 'architect', 'coder', 'tester', 'reviewer']);
    expect(ROLES.every((role) => role.source === 'builtin')).toBe(true);
  });

  it('findRole 只找內建的，角色庫的找不到', () => {
    expect(findRole('reviewer')?.label).toBe('審查者');
    expect(findRole('lib:engineering/code-reviewer')).toBeUndefined();
  });

  it('lib: 前綴認得出來', () => {
    expect(isLibraryRole('lib:engineering/x')).toBe(true);
    expect(isLibraryRole('coder')).toBe(false);
  });
});

describe('mergeRoles / findRoleIn', () => {
  it('內建在前、角色庫在後', () => {
    const merged = mergeRoles(ROLES, [reviewer, tester]);
    expect(merged).toHaveLength(ROLES.length + 2);
    expect(merged.slice(0, ROLES.length)).toEqual([...ROLES]);
    expect(merged.at(-1)).toBe(tester);
  });

  it('findRoleIn 兩種來源都找得到，找不到就是 undefined', () => {
    const merged = mergeRoles(ROLES, [reviewer]);
    expect(findRoleIn(merged, 'coder')?.label).toBe('工程師');
    expect(findRoleIn(merged, 'lib:engineering/code-reviewer')).toBe(reviewer);
    expect(findRoleIn(merged, 'lib:沒有這個')).toBeUndefined();
  });
});

describe('filterRoles', () => {
  const all = mergeRoles(ROLES, [reviewer, tester]);

  it('空字串就是全部', () => {
    expect(filterRoles(all, '')).toHaveLength(all.length);
    expect(filterRoles(all, '   ')).toHaveLength(all.length);
  });

  it('名稱比對不分大小寫', () => {
    expect(filterRoles(all, 'aPi TeStEr')).toEqual([tester]);
    expect(filterRoles(all, 'tester').map((r) => r.id)).toEqual([
      'tester',
      'lib:testing/api-tester',
    ]);
  });

  it('說明、分類、id 也在比對範圍裡', () => {
    expect(filterRoles(all, 'mentor')).toEqual([reviewer]);
    expect(filterRoles(all, 'engineering')).toEqual([reviewer]);
    expect(filterRoles(all, 'lib:testing')).toEqual([tester]);
  });

  it('中文的內建角色也找得到', () => {
    expect(filterRoles(all, '審查').map((r) => r.id)).toEqual(['reviewer']);
  });
});

describe('groupRoles', () => {
  it('內建永遠第一組，其餘分類照名稱排', () => {
    const groups = groupRoles(mergeRoles(ROLES, [tester, reviewer]));
    expect(groups.map((g) => g.division)).toEqual(['內建', 'Engineering', 'Testing']);
    expect(groups[0].roles).toHaveLength(ROLES.length);
    expect(groups[1].roles).toEqual([reviewer]);
  });

  it('沒有分類的角色庫檔案歸在未分類', () => {
    expect(groupRoles([loose])).toEqual([{ division: '未分類', roles: [loose] }]);
  });

  it('只有角色庫時就沒有內建那一組', () => {
    expect(groupRoles([reviewer]).map((g) => g.division)).toEqual(['Engineering']);
  });

  it('空清單就是空的', () => {
    expect(groupRoles([])).toEqual([]);
  });
});

describe('roleTagText', () => {
  it('有 emoji 就擺在名稱前面', () => {
    expect(roleTagText(reviewer)).toBe('👁️ Code Reviewer');
    expect(roleTagText(tester)).toBe('API Tester');
    expect(roleTagText(ROLES[0])).toBe('產品經理');
  });
});
