import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectAlive, root } from './helpers';
import {
  envWith,
  freshDir,
  launch,
  newSession,
  screenText,
  typeLine,
  waitProbed,
} from './checklist-helpers';

/**
 * 手動檢查表 D7、D9、D12、E5、E6、F4、F7、F10、F12、F13。
 * 不呼叫任何 CLI 的模型：F4 的金鑰是用 echo 印環境變數驗的，claude 本身沒被叫起來；
 * F10 / F13 把 USERPROFILE 換成暫存目錄，讀不到也改不到使用者真的憑證。
 */

const shot = (window: Page, name: string) =>
  window.screenshot({ path: join(root, 'test-results', `${name}.png`) });

const PS_PROMPT = 'PS ';

async function powershell(window: Page): Promise<void> {
  await newSession(window, 'powershell');
  await expect.poll(() => screenText(window), { timeout: 30_000 }).toContain(PS_PROMPT);
}

/** 長行會折行，比對之前先把換行拿掉。*/
const flat = async (window: Page): Promise<string> => (await screenText(window)).replace(/\n/g, '');

// ---- D 工具列 ----

test('D7 貼上 50 KB 單行：幾秒內貼完、期間 app 可操作、Ctrl+C 清掉之後還能用', async () => {
  test.setTimeout(120_000);
  const { app, window, dialogs } = await launch(freshDir('checklist-d7'));
  try {
    await powershell(window);
    // 開頭是 #：就算真的被執行也只是一行註解。
    const text = `#${'a'.repeat(50 * 1024)}D7_END`;
    await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);

    const started = Date.now();
    await window.click('#btn-paste');

    // 貼的同時 app 還按得動：新連接的對話框打得開也關得掉。
    const clicked = Date.now();
    await window.click('#btn-new');
    await expect(window.locator('#new-connection')).toBeVisible({ timeout: 5_000 });
    const responsiveMs = Date.now() - clicked;
    await window.click('#f-cancel');
    await expect(window.locator('#new-connection')).toBeHidden();

    await expect.poll(() => flat(window), { timeout: 20_000 }).toContain('D7_END');
    const pasteMs = Date.now() - started;
    console.log(`[D7] 50 KB 貼完 ${pasteMs} ms；貼上期間開新連接對話框 ${responsiveMs} ms`);
    await shot(window, 'd7-pasted');

    // Ctrl+C 清掉那一整行，接著照常下指令。
    await window.locator('.term-host:not([hidden]) .xterm-screen').click();
    await window.keyboard.press('Control+C');
    await typeLine(window, 'echo AFTER_D7');
    await expect.poll(() => screenText(window), { timeout: 20_000 }).toMatch(/^AFTER_D7\s*$/m);

    expect(pasteMs).toBeLessThan(20_000);
    expect(dialogs).toEqual([]);
    await expectAlive(app, window);
  } finally {
    await app.close();
  }
});

test('D9 已結束的工作階段：紀錄按鈕停用，按了也不會產生紀錄檔', async () => {
  const logDir = freshDir('checklist-d9-logs');
  const { app, window, dialogs } = await launch(freshDir('checklist-d9'), {
    env: envWith({ MYTERMINAL_LOG_DIR: logDir }),
  });
  try {
    await powershell(window);
    await expect(window.locator('#btn-log')).toBeEnabled();
    await typeLine(window, 'exit');
    await expect(window.locator('.session-item')).toContainText('已結束', { timeout: 20_000 });

    await expect(window.locator('#btn-log')).toBeDisabled();
    // 硬按：滑鼠點與 DOM 的 click() 都試一次。
    await window.locator('#btn-log').click({ force: true });
    await window.evaluate(() => document.getElementById('btn-log')?.click());
    await window.waitForTimeout(1500);

    await expect(window.locator('#btn-log .btn-label')).toHaveText('紀錄');
    await expect(window.locator('.session-item .session-state.logging')).toHaveCount(0);
    expect(readdirSync(logDir), `${logDir} 不該有檔案`).toEqual([]);
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

test('D12 新連接對話框按 Esc：關閉，什麼都不建立', async () => {
  const userData = freshDir('checklist-d12');
  const { app, window, dialogs } = await launch(userData);
  try {
    await window.click('#btn-new');
    await expect(window.locator('#new-connection')).toBeVisible();
    await window.fill('#f-name', 'ESC 不該建立');
    await window.check('#f-save');
    await window.keyboard.press('Escape');

    await expect(window.locator('#new-connection')).toBeHidden();
    await window.waitForTimeout(1000);
    await expect(window.locator('.session-item')).toHaveCount(0);
    await expect(window.locator('#empty-hint')).toBeVisible();
    await expect(window.locator('#profile-list .profile-item')).toHaveCount(0);
    expect(existsSync(join(userData, 'profiles.json'))).toBe(false);
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

// ---- E 已儲存連線 ----

const storedProfiles = (userData: string): Array<{ name: string; type: string }> =>
  JSON.parse(readFileSync(join(userData, 'profiles.json'), 'utf8'));

test('E5 同名覆蓋：先存 WSL 的 dup 再存 PowerShell 的 dup，只剩一個 PowerShell，沒有確認', async () => {
  test.setTimeout(120_000);
  const userData = freshDir('checklist-e5');
  const { app, window, dialogs } = await launch(userData);
  try {
    await newSession(window, 'wsl', async () => {
      await window.fill('#f-name', 'dup');
      await window.check('#f-save');
    });
    const item = window.locator('#profile-list .profile-item[data-name="dup"]');
    await expect(item).toHaveCount(1);
    await expect(item.locator('.session-tag')).toHaveText('WSL');

    await newSession(window, 'powershell', async () => {
      await window.fill('#f-name', 'dup');
      await window.check('#f-save');
    });
    await expect(item.locator('.session-tag')).toHaveText('PowerShell');
    await expect(window.locator('#profile-list .profile-item')).toHaveCount(1);
    await expect(window.locator('#profile-count')).toHaveText('1');

    const saved = storedProfiles(userData).filter((p) => p.name === 'dup');
    expect(saved).toHaveLength(1);
    expect(saved[0].type).toBe('powershell');
    // 已知行為：直接覆蓋，沒有確認框。
    expect(dialogs).toEqual([]);
    await shot(window, 'e5-dup');
  } finally {
    await app.close();
  }
});

test('E6 名稱含中文與 emoji：側欄、已儲存連線、profiles.json 都正確，重開也一樣', async () => {
  const NAME = '測試 🚀 名稱';
  const userData = freshDir('checklist-e6');
  const first = await launch(userData);
  try {
    await newSession(first.window, 'powershell', async () => {
      await first.window.fill('#f-name', NAME);
      await first.window.check('#f-save');
    });
    await expect(first.window.locator('.session-item .session-name')).toHaveText(NAME);
    await expect(first.window.locator('#profile-list .profile-item .profile-name')).toHaveText(NAME);
    await expect(first.window.locator('#profile-list .profile-item')).toHaveAttribute(
      'data-name',
      NAME,
    );
    const raw = readFileSync(join(userData, 'profiles.json'), 'utf8');
    expect(raw).toContain(NAME);
    expect(storedProfiles(userData).map((p) => p.name)).toEqual([NAME]);
    await shot(first.window, 'e6-emoji');
    expect(first.dialogs).toEqual([]);
  } finally {
    await first.app.close();
  }

  const second = await launch(userData);
  try {
    await expect(second.window.locator('#profile-list .profile-item .profile-name')).toHaveText(
      NAME,
    );
    await second.window.click('#profile-list .profile-item');
    await expect(second.window.locator('.session-item .session-name')).toHaveText(NAME);
  } finally {
    await second.app.close();
  }
});

// ---- F CLI 設定 ----

async function openSettings(window: Page): Promise<void> {
  await window.click('#btn-cli-settings');
  await expect(window.locator('#cli-settings')).toBeVisible();
}

test('F4 Claude 的 API 金鑰只注入 Claude 類型的工作階段，PowerShell 拿不到', async () => {
  test.setTimeout(120_000);
  const KEY = 'sk-ant-test-123';
  // 開發機環境裡本來就有這個變數的話，第二半會誤判，所以先拿掉。
  const { app, window, dialogs } = await launch(freshDir('checklist-f4'), {
    env: envWith({}, ['ANTHROPIC_API_KEY']),
  });
  try {
    await openSettings(window);
    await window.check('#cli-claude-mode-apiKey');
    await window.fill('#cli-claude-key', KEY);
    await window.click('#cli-claude-save');
    await expect(window.locator('#cli-errors')).toHaveText('');
    // 開機那一輪探測跑完之前狀態一律寫「偵測中…」，所以給它時間。
    await expect(window.locator('#cli-claude-status')).toHaveText('API 金鑰', { timeout: 30_000 });
    await window.click('#cli-close');
    await expect(window.locator('#cli-settings')).toBeHidden();

    // Claude 類型的工作階段，但啟動指令換成印環境變數 —— 不會真的叫 claude。
    await newSession(window, 'claude', async () => {
      await window.selectOption('#f-base-shell', 'powershell');
      await window.fill('#f-startup', 'echo KEY=$env:ANTHROPIC_API_KEY');
    });
    await expect
      .poll(() => screenText(window), { timeout: 40_000 })
      .toMatch(new RegExp(`^KEY=${KEY}\\s*$`, 'm'));
    await shot(window, 'f4-claude');

    await powershell(window);
    await typeLine(window, 'echo KEY=$env:ANTHROPIC_API_KEY');
    await expect.poll(() => screenText(window), { timeout: 20_000 }).toMatch(/^KEY=\s*$/m);
    expect(await screenText(window)).not.toContain(KEY);
    await shot(window, 'f4-powershell');

    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

test('F7 Codex 列有「ChatGPT 登入優先，要用金鑰先 codex logout」的提示', async () => {
  const { app, window } = await launch(freshDir('checklist-f7'));
  try {
    await openSettings(window);
    const hint = window.locator('.cli-row[data-cli="codex"] .cli-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('ChatGPT');
    await expect(hint).toContainText('codex logout');
    await window.click('#cli-close');
  } finally {
    await app.close();
  }
});

test('F10 OpenCode 選免費模型：金鑰欄收起、型號預填 mimo-v2.5-free、狀態變 API 金鑰', async () => {
  test.setTimeout(90_000);
  // 假的家目錄：CLI 探測在這裡讀不到任何憑證 (這台機器的 opencode 本來也是 0 credentials)。
  const home = freshDir('checklist-f10-home');
  const { app, window, dialogs } = await launch(freshDir('checklist-f10'), {
    env: envWith({ USERPROFILE: home, HOME: home }),
  });
  try {
    await waitProbed(window);
    const before = await window.locator('#cli-opencode').textContent();

    await openSettings(window);
    await window.selectOption('#cli-opencode-provider', 'opencode');
    await expect(window.locator('#cli-opencode-key-row')).toBeHidden();
    await expect(window.locator('#cli-opencode-model')).toHaveValue('mimo-v2.5-free');
    await window.click('#cli-opencode-save');
    await expect(window.locator('#cli-errors')).toHaveText('');
    // 存完再按一次「重新偵測」：探測也有機會看到新的設定。
    await window.click('#cli-refresh');
    await waitProbed(window);
    await shot(window, 'f10-opencode');

    const row = await window.locator('#cli-opencode-status').textContent();
    const chip = await window.locator('#cli-opencode').textContent();
    console.log(`[F10] 存之前晶片「${before}」；存之後列狀態「${row}」、晶片「${chip}」`);
    await expect(window.locator('#cli-opencode-status')).toHaveText('API 金鑰');
    await expect(window.locator('#cli-opencode')).toHaveText('OpenCode · API 金鑰');
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

/** PATH 拿掉 %LOCALAPPDATA%\Programs\muse 那一段 (或補回去)。*/
const MUSE_DIR = /programs[\\/]muse[\\/]?$/i;
const pathEntries = (): string[] => (process.env.PATH ?? '').split(';').filter(Boolean);

test('F12 PATH 上沒有 Muse：晶片寫「找不到指令」；放回 PATH 重開就恢復偵測', async () => {
  test.setTimeout(120_000);
  const userData = freshDir('checklist-f12');

  const without = pathEntries().filter((p) => !MUSE_DIR.test(p));
  const first = await launch(userData, { env: envWith({ PATH: without.join(';') }) });
  try {
    await waitProbed(first.window);
    await expect(first.window.locator('#cli-muse')).toHaveText('Muse · 找不到指令');
    await shot(first.window, 'f12-missing');
  } finally {
    await first.app.close();
  }

  const museDir = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'muse');
  const withMuse = pathEntries().some((p) => MUSE_DIR.test(p))
    ? pathEntries()
    : [museDir, ...pathEntries()];
  const second = await launch(userData, { env: envWith({ PATH: withMuse.join(';') }) });
  try {
    await waitProbed(second.window);
    const chip = await second.window.locator('#cli-muse').textContent();
    console.log(`[F12] 放回 PATH 之後：${chip}`);
    await expect(second.window.locator('#cli-muse')).not.toContainText('找不到指令');
  } finally {
    await second.app.close();
  }
});

test('F13 在外面改 Muse 的 auth.json 再按重新偵測：偵測中、按鈕停用，結果跟著變，不必重開', async () => {
  test.setTimeout(120_000);
  // 假的家目錄：只動這裡的 .config/muse/auth.json，不碰使用者真的那一份。
  const home = freshDir('checklist-f13-home');
  const museDir = join(home, '.config', 'muse');
  mkdirSync(museDir, { recursive: true });
  const auth = join(museDir, 'auth.json');
  const moved = join(museDir, 'auth.json.bak');
  writeFileSync(
    auth,
    JSON.stringify({ schema_version: 1, providers: { meta: { api_key: 'dummy' } } }),
    'utf8',
  );

  const { app, window, dialogs } = await launch(freshDir('checklist-f13'), {
    env: envWith({ USERPROFILE: home, HOME: home }),
  });
  const chips = ['claude', 'codex', 'muse', 'opencode'].map((id) => window.locator(`#cli-${id}`));
  try {
    await waitProbed(window);
    await expect(window.locator('#cli-muse')).toHaveText('Muse · API 金鑰');

    // 1. 等於在外面登出：檔案改名，按頁尾的「重新偵測」。
    renameSync(auth, moved);
    await window.click('#btn-cli-refresh');
    for (const chip of chips) await expect(chip).toContainText('偵測中', { timeout: 2_000 });
    await expect(window.locator('#btn-cli-refresh')).toBeDisabled();
    // 頁尾那顆不會順便打開「CLI 設定」。
    await expect(window.locator('#cli-settings')).toBeHidden();
    await shot(window, 'f13-probing');
    await waitProbed(window);
    await expect(window.locator('#cli-muse')).toHaveText('Muse · 未登入');
    await expect(window.locator('#btn-cli-refresh')).toBeEnabled();

    // 2. 改回來，從「CLI 設定」標題旁的「重新偵測」再探一次。
    renameSync(moved, auth);
    await openSettings(window);
    await window.click('#cli-refresh');
    await expect(window.locator('#cli-muse-status')).toHaveText('偵測中…', { timeout: 2_000 });
    await expect(window.locator('#cli-refresh')).toBeDisabled();
    await expect(window.locator('#btn-cli-refresh')).toBeDisabled();
    for (const chip of chips) await expect(chip).toContainText('偵測中');
    await expect(window.locator('#cli-muse-status')).toHaveText('API 金鑰', { timeout: 30_000 });
    await expect(window.locator('#cli-refresh')).toBeEnabled();
    await expect(window.locator('#cli-muse')).toHaveText('Muse · API 金鑰');

    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});
