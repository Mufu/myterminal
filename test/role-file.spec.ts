import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDivisions, parseRoleFile } from '../src/shared/role-file';

/**
 * 角色庫的檔案解析。三個 fixture 是從 https://github.com/Mufu/agency-agents
 * 原封不動抄過來的真實檔案 (見 fixtures/roles/LICENSE-NOTE.md)，
 * 其餘是手寫的邊界情況 —— 使用者的資料夾裡什麼都可能有。
 */

const FIXTURES = join(__dirname, 'fixtures', 'roles');
const fixture = (relPath: string): string => readFileSync(join(FIXTURES, relPath), 'utf8');

const divisions = parseDivisions(fixture('divisions.json'));

describe('parseRoleFile 讀真的角色檔', () => {
  it('frontmatter 的三個欄位與整篇本文', () => {
    const relPath = 'engineering/engineering-code-reviewer.md';
    const role = parseRoleFile(relPath, fixture(relPath), divisions);

    expect(role).toMatchObject({
      id: 'lib:engineering/engineering-code-reviewer',
      label: 'Code Reviewer',
      emoji: '👁️',
      division: 'Engineering',
      source: 'library',
      defaultPermission: 'readonly',
    });
    expect(role?.description).toContain('constructive, actionable feedback');
    // 本文就是系統提示：frontmatter 不在裡面，前後的空行也修掉了。
    expect(role?.systemPrompt.startsWith('# Code Reviewer Agent')).toBe(true);
    expect(role?.systemPrompt).toContain('You are **Code Reviewer**');
    expect(role?.systemPrompt).not.toContain('vibe:');
  });

  it('frontmatter 多了不認得的欄位 (tools) 也照樣讀得出來', () => {
    const relPath = 'product/product-manager.md';
    const role = parseRoleFile(relPath, fixture(relPath), divisions);

    expect(role).toMatchObject({
      id: 'lib:product/product-manager',
      label: 'Product Manager',
      division: 'Product',
      emoji: '🧭',
    });
    expect(role?.systemPrompt).toContain('Product Manager Agent');
  });

  it('另一個分類的檔案，分類跟著它所在的目錄', () => {
    const relPath = 'testing/testing-api-tester.md';
    const role = parseRoleFile(relPath, fixture(relPath), divisions);

    expect(role).toMatchObject({
      id: 'lib:testing/testing-api-tester',
      label: 'API Tester',
      division: 'Testing',
    });
  });
});

describe('parseRoleFile 的邊界情況', () => {
  const body = '---\nname: X\n---\n本文\n';

  it('沒有 frontmatter 的就不是角色 (README 之類的)', () => {
    expect(parseRoleFile('README.md', '# Agency Agents\n\n一堆說明\n')).toBeNull();
  });

  it('有 frontmatter 但沒有 name 也不算角色', () => {
    expect(parseRoleFile('x.md', '---\ndescription: 沒名字\n---\n本文\n')).toBeNull();
  });

  it('frontmatter 沒有收尾的 --- 就不算', () => {
    expect(parseRoleFile('x.md', '---\nname: X\n本文\n')).toBeNull();
  });

  it('空檔案是 null', () => {
    expect(parseRoleFile('x.md', '')).toBeNull();
  });

  it('值兩側的引號拿掉，說明裡的冒號留著', () => {
    const role = parseRoleFile(
      'x.md',
      '---\nname: "Senior Developer"\ndescription: \'Premium: Laravel, Three.js\'\n---\n本文\n',
    );
    expect(role?.label).toBe('Senior Developer');
    expect(role?.description).toBe('Premium: Laravel, Three.js');
  });

  it('CRLF 換行也讀得出來', () => {
    const role = parseRoleFile('e/x.md', '---\r\nname: X\r\nemoji: 💎\r\n---\r\n本文\r\n');
    expect(role).toMatchObject({ label: 'X', emoji: '💎' });
    expect(role?.systemPrompt).toBe('本文');
  });

  it('本文裡的 --- 是分隔線，不會被當成 frontmatter 的收尾', () => {
    const role = parseRoleFile('x.md', '---\nname: X\n---\n第一段\n\n---\n\n第二段\n');
    expect(role?.systemPrompt).toBe('第一段\n\n---\n\n第二段');
  });

  it('沒有分類 (直接躺在根目錄) 就是未分類', () => {
    expect(parseRoleFile('x.md', body)?.division).toBe('未分類');
  });

  it('divisions.json 沒寫到的目錄就用目錄名本身', () => {
    expect(parseRoleFile('mystuff/x.md', body, divisions)?.division).toBe('mystuff');
  });

  it('更深的目錄看最上層那一層，id 仍然是完整的相對路徑', () => {
    const role = parseRoleFile('engineering/web/x.md', body, divisions);
    expect(role).toMatchObject({ id: 'lib:engineering/web/x', division: 'Engineering' });
  });

  it('Windows 的反斜線路徑換成正斜線', () => {
    expect(parseRoleFile('engineering\\x.md', body)?.id).toBe('lib:engineering/x');
  });

  it('沒有 emoji / description 就不長出那兩個欄位', () => {
    const role = parseRoleFile('x.md', body);
    expect(role).not.toHaveProperty('emoji');
    expect(role).not.toHaveProperty('description');
  });
});

describe('parseDivisions', () => {
  it('真的那一份：divisions 底下的 label，_note 略過', () => {
    expect(divisions.engineering).toBe('Engineering');
    expect(divisions.testing).toBe('Testing');
    expect(divisions['game-development']).toBe('Game Development');
    expect(divisions).not.toHaveProperty('_note');
    expect(divisions).not.toHaveProperty('divisions');
  });

  it('手寫的扁平版本 (目錄名 -> 字串) 也讀得懂', () => {
    expect(parseDivisions('{"eng":"工程","_note":"x"}')).toEqual({ eng: '工程' });
  });

  it('壞掉或不是物件就當成沒有', () => {
    expect(parseDivisions('{ 不是 JSON')).toEqual({});
    expect(parseDivisions('[]')).toEqual({});
    expect(parseDivisions('null')).toEqual({});
  });

  it('沒有 label 的項目略過', () => {
    expect(parseDivisions('{"divisions":{"a":{"icon":"Code"},"b":{"label":"B"}}}')).toEqual({
      b: 'B',
    });
  });
});
