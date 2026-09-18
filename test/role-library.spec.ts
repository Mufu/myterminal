import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RoleLibrary, rolesOf } from '../src/main/role-library';
import type { MarkdownFile } from '../src/main/role-library';
import { ROLES } from '../src/shared/roles';

/**
 * 角色庫的掃描規則。檔案系統走注入的兩個縫線，
 * 所以這裡描述的是「哪些檔案算角色」，不是「怎麼走資料夾」。
 */

const FIXTURES = join(__dirname, 'fixtures', 'roles');
const fixture = (relPath: string): MarkdownFile => ({
  relPath,
  text: readFileSync(join(FIXTURES, relPath), 'utf8'),
});
const divisionsJson = readFileSync(join(FIXTURES, 'divisions.json'), 'utf8');

const role = (relPath: string, name: string): MarkdownFile => ({
  relPath,
  text: `---\nname: ${name}\n---\n你是 ${name}。\n`,
});

/** 注入的縫線：記下被問過幾次，快取才驗得出來。*/
function library(files: MarkdownFile[], divisions: string | null = null) {
  const calls = { list: 0, divisions: 0 };
  const lib = new RoleLibrary(
    () => {
      calls.list += 1;
      return files;
    },
    () => {
      calls.divisions += 1;
      return divisions;
    },
    () => 1700000000000,
  );
  return { lib, calls };
}

describe('RoleLibrary.scan', () => {
  it('每個有 frontmatter 的 markdown 就是一個角色，其餘記進 skipped', () => {
    const { lib } = library([
      fixture('engineering/engineering-code-reviewer.md'),
      fixture('testing/testing-api-tester.md'),
      { relPath: 'README.md', text: '# Agency Agents\n說明\n' },
    ]);

    const scan = lib.scan('D:\\roles');
    expect(scan.roles.map((r) => r.id)).toEqual([
      'lib:engineering/engineering-code-reviewer',
      'lib:testing/testing-api-tester',
    ]);
    expect(scan.skipped).toEqual([
      { relPath: 'README.md', reason: '沒有 frontmatter 的 name' },
    ]);
    expect(scan).toMatchObject({ dir: 'D:\\roles', scannedAt: 1700000000000 });
  });

  it('divisions.json 讀得到就用它的顯示名稱，讀不到就用目錄名', () => {
    const files = [fixture('engineering/engineering-code-reviewer.md')];
    expect(library(files, divisionsJson).lib.scan('d').roles[0].division).toBe('Engineering');
    expect(library(files).lib.scan('d').roles[0].division).toBe('engineering');
  });

  it('不是角色的四個資料夾與點開頭的資料夾都略過', () => {
    const { lib } = library([
      role('integrations/claude/x.md', 'X'),
      role('strategy/playbook.md', 'Y'),
      role('examples/demo.md', 'Z'),
      role('scripts/notes.md', 'W'),
      role('.github/ISSUE_TEMPLATE.md', 'V'),
      role('engineering/keeper.md', 'Keeper'),
    ]);

    const scan = lib.scan('d');
    expect(scan.roles.map((r) => r.id)).toEqual(['lib:engineering/keeper']);
    expect(scan.skipped.map((s) => s.relPath)).toEqual([
      'integrations/claude/x.md',
      'strategy/playbook.md',
      'examples/demo.md',
      'scripts/notes.md',
      '.github/ISSUE_TEMPLATE.md',
    ]);
    expect(new Set(scan.skipped.map((s) => s.reason))).toEqual(new Set(['不是角色資料夾']));
  });

  it('根目錄下同名的檔案不算在那四個資料夾裡', () => {
    const { lib } = library([role('scripts.md', 'Scripts')]);
    expect(lib.scan('d').roles.map((r) => r.id)).toEqual(['lib:scripts']);
  });

  it('資料夾是空的 (或根本不存在) 就是沒有角色，不是錯誤', () => {
    const { lib } = library([]);
    expect(lib.scan('D:\\沒有這個')).toMatchObject({ roles: [], skipped: [] });
  });

  it('Windows 的反斜線相對路徑也吃得下', () => {
    const { lib } = library([role('engineering\\keeper.md', 'Keeper')]);
    expect(lib.scan('d').roles[0].id).toBe('lib:engineering/keeper');
  });
});

describe('RoleLibrary 的快取', () => {
  it('同一個資料夾只讀一次', () => {
    const { lib, calls } = library([role('e/x.md', 'X')]);
    lib.scan('d');
    lib.scan('d');
    expect(calls).toEqual({ list: 1, divisions: 1 });
  });

  it('rescan 一定重讀', () => {
    const { lib, calls } = library([role('e/x.md', 'X')]);
    lib.scan('d');
    lib.rescan('d');
    expect(calls.list).toBe(2);
  });

  it('換了資料夾就重讀', () => {
    const { lib, calls } = library([role('e/x.md', 'X')]);
    lib.scan('d1');
    lib.scan('d2');
    expect(calls.list).toBe(2);
  });
});

describe('rolesOf', () => {
  it('內建五個在前，掃出來的接在後面', () => {
    const { lib } = library([role('e/x.md', 'X')]);
    const all = rolesOf(lib.scan('d'));
    expect(all).toHaveLength(ROLES.length + 1);
    expect(all[0].id).toBe('pm');
    expect(all.at(-1)?.id).toBe('lib:e/x');
  });
});
