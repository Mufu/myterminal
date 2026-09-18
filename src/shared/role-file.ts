import type { RoleInfo } from './roles';
import { LIBRARY_ROLE_PREFIX, UNSORTED_DIVISION } from './roles';

/**
 * 角色庫的檔案格式：一段 frontmatter 之後整篇 markdown 就是系統提示。
 *
 *     ---
 *     name: Code Reviewer
 *     description: …
 *     emoji: 👁️
 *     ---
 *     # Code Reviewer Agent
 *     You are …
 *
 * 純函式，不碰檔案系統 —— 讀檔是 main/role-library.ts 的事。
 * 刻意不引 YAML 函式庫：只認 `key: value` 這種一行一個的寫法，
 * 認不得的行 (清單、巢狀) 直接忽略，因為我們只要三個欄位。
 */

/** 只在開頭的 `---` 與下一個單獨成行的 `---` 之間算 frontmatter。*/
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseRoleFile(
  relPath: string,
  text: string,
  /** divisions.json 解出來的「目錄名 -> 顯示名稱」；沒有就用目錄名本身。*/
  divisions: Record<string, string> = {},
): RoleInfo | null {
  const match = FRONTMATTER.exec(text.replace(/^﻿/, ''));
  // 沒有 frontmatter 的就不是角色 (README、CONTRIBUTING 都長這樣)。
  if (!match) return null;

  const fields = readFields(match[1]);
  const label = fields.name;
  if (!label) return null;

  const path = normalize(relPath);
  const slash = path.lastIndexOf('/');
  const dir = slash < 0 ? '' : path.slice(0, slash);
  // 巢狀更深的時候看第一段就好 —— 分類就是最上層那一層目錄。
  const top = dir.split('/')[0];

  const role: RoleInfo = {
    id: `${LIBRARY_ROLE_PREFIX}${path.replace(/\.md$/i, '')}`,
    label,
    systemPrompt: text.slice(match[0].length).trim(),
    // 別人寫的提示我們讀不完，預設就給最保守的唯讀。
    defaultPermission: 'readonly',
    source: 'library',
    division: top ? (divisions[top] ?? top) : UNSORTED_DIVISION,
  };
  if (fields.description) role.description = fields.description;
  if (fields.emoji) role.emoji = fields.emoji;
  return role;
}

/**
 * divisions.json：目錄名 -> 顯示名稱。真的那一份是
 * `{ "_note": "…", "divisions": { "engineering": { "label": "Engineering", … } } }`，
 * 但手寫一份 `{ "engineering": "Engineering" }` 也讀得懂。壞掉就當成沒有。
 */
export function parseDivisions(text: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};

  const inner = (parsed as Record<string, unknown>).divisions;
  const source = typeof inner === 'object' && inner !== null ? inner : parsed;

  const out: Record<string, string> = {};
  for (const [dir, value] of Object.entries(source as Record<string, unknown>)) {
    // `_note` 是給人看的說明，不是一個分類。
    if (dir.startsWith('_')) continue;
    const label = typeof value === 'string' ? value : readLabel(value);
    if (label) out[dir] = label;
  }
  return out;
}

function readLabel(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const label = (value as Record<string, unknown>).label;
  return typeof label === 'string' && label.trim() ? label.trim() : undefined;
}

/** frontmatter 的 `key: value`；值兩側的引號拿掉，說明裡的冒號留著。*/
function readFields(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    // 縮排的行是巢狀結構的一部分，我們不支援也用不到。
    if (colon <= 0 || /^\s/.test(line)) continue;
    const key = line.slice(0, colon).trim();
    const value = unquote(line.slice(colon + 1).trim());
    if (key && value) out[key] = value;
  }
  return out;
}

function unquote(value: string): string {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  return quoted ? quoted[2].trim() : value;
}

/** Windows 的反斜線與多餘的前綴都先弄掉，id 才跟平台無關。*/
function normalize(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}
