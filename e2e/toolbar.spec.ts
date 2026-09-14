import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { activeRows, freshUserData, launchApp, root, runInTerminal } from './helpers';

const userData = freshUserData('toolbar');
/** 紀錄檔寫到 test-results 底下，不要碰使用者自己的 %USERPROFILE%\myterminal-logs。*/
const logDir = join(root, 'test-results', 'toolbar-logs');
rmSync(logDir, { recursive: true, force: true });
mkdirSync(logDir, { recursive: true });

const shot = (window: Page, name: string) =>
  window.screenshot({ path: join(root, 'test-results', `toolbar-${name}.png`) });

/** 畫面上出現幾次。貼上時回顯會先到，輸出是之後才來的，所以要等到兩次。*/
const countOn = async (window: Page, mark: string): Promise<number> => {
  const text = await activeRows(window).innerText();
  return text.match(new RegExp(mark, 'g'))?.length ?? 0;
};

/** 紀錄檔裡有一堆終端機控制碼，比對文字前先拿掉。*/
const stripAnsi = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\][^]*(?:|\\)/g, '').replace(/\[[0-9;?]*[ -/]*[@-~]/g, '');

/** 開 app 並備妥一個 PowerShell 工作階段 —— 工具列的按鈕都要有作用中的工作階段。*/
async function openWithSession(): Promise<{
  app: ElectronApplication;
  window: Page;
  dialogs: string[];
}> {
  const { app, window } = await launchApp(userData, { MYTERMINAL_LOG_DIR: logDir });
  const dialogs: string[] = [];
  window.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  await window.click('#btn-new');
  await window.selectOption('#f-type', 'powershell');
  await window.click('#f-ok');
  await expect(activeRows(window)).toContainText('PS ', { timeout: 30_000 });
  return { app, window, dialogs };
}

test('輸入字：兩行一次送出，兩行的輸出都出現，標題顯示送到 PowerShell 1', async () => {
  const { app, window, dialogs } = await openWithSession();

  await window.click('#btn-input');
  await expect(window.locator('#input-panel')).toBeVisible();
  await expect(window.locator('#btn-input')).toHaveClass(/on/);
  await expect(window.locator('#input-target')).toContainText('送到 PowerShell 1');
  await expect(window.locator('#input-target-name')).toHaveText('PowerShell 1');

  await window.fill('#input-text', 'echo LINE_ONE\necho LINE_TWO');
  await window.click('#btn-send');

  // 送出後輸入區清空
  await expect(window.locator('#input-text')).toHaveValue('');

  await expect.poll(() => countOn(window, 'LINE_TWO'), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await shot(window, 'input');

  const text = await activeRows(window).innerText();
  const seen = `終端機畫面：\n${text}`;
  // 兩行都真的「執行」過：回顯一次 + 輸出一次。
  expect(text.match(/LINE_ONE/g)?.length ?? 0, seen).toBeGreaterThanOrEqual(2);
  expect(text.match(/LINE_TWO/g)?.length ?? 0, seen).toBeGreaterThanOrEqual(2);
  // 順序：LINE_ONE 的輸出在 LINE_TWO 之前
  expect(text.indexOf('LINE_ONE'), seen).toBeLessThan(text.indexOf('LINE_TWO'));

  expect(dialogs).toEqual([]);
  await app.close();
});

test('貼上：剪貼簿的內容送進工作階段，按 Enter 就執行', async () => {
  const { app, window, dialogs } = await openWithSession();

  await app.evaluate(({ clipboard }) => clipboard.writeText('echo PASTE_OK'));
  await window.click('#btn-paste');

  // 貼上只是寫進 pty，還要自己按 Enter。
  await window.locator('.term-host:not([hidden]) .xterm-screen').click();
  await window.keyboard.press('Enter');

  await expect(activeRows(window)).toContainText('PASTE_OK', { timeout: 20_000 });
  await shot(window, 'paste');
  expect(dialogs).toEqual([]);
  await app.close();
});

test('貼上：多行的剪貼簿內容一次進去，按 Enter 三行都執行', async () => {
  const { app, window, dialogs } = await openWithSession();

  await app.evaluate(({ clipboard }) =>
    clipboard.writeText('echo PASTE_A\necho PASTE_B\necho PASTE_C\n'),
  );
  await window.click('#btn-paste');

  // bracketed paste 進去的是一段多行緩衝區，還要自己按 Enter 才執行。
  await window.locator('.term-host:not([hidden]) .xterm-screen').click();
  await window.keyboard.press('Enter');

  await expect.poll(() => countOn(window, 'PASTE_C'), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  const text = await activeRows(window).innerText();
  const seen = `終端機畫面：\n${text}`;
  // 三行都真的「執行」過：回顯一次 + 輸出一次。
  for (const mark of ['PASTE_A', 'PASTE_B', 'PASTE_C']) {
    expect(text.match(new RegExp(mark, 'g'))?.length ?? 0, seen).toBeGreaterThanOrEqual(2);
  }
  expect(text.indexOf('PASTE_A'), seen).toBeLessThan(text.indexOf('PASTE_B'));
  expect(text.indexOf('PASTE_B'), seen).toBeLessThan(text.indexOf('PASTE_C'));
  await shot(window, 'paste-multiline');

  expect(dialogs).toEqual([]);
  await app.close();
});

test('複製文字：在終端機選一行，按複製之後剪貼簿就是那一行', async () => {
  const { app, window, dialogs } = await openWithSession();

  await runInTerminal(window, 'echo COPY_ME_42');
  await expect(activeRows(window)).toContainText('COPY_ME_42', { timeout: 20_000 });

  // 三連點選一整行：xterm 的 DOM renderer 一列就是 .xterm-rows 底下一個 div。
  const outputRow = window
    .locator('.term-host:not([hidden]) .xterm-rows > div')
    .filter({ hasText: /^COPY_ME_42\s*$/ });
  await expect(outputRow).toHaveCount(1);
  await outputRow.click({ clickCount: 3 });

  await window.click('#btn-copy');
  await shot(window, 'copy');

  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(clip).toContain('COPY_ME_42');
  expect(dialogs).toEqual([]);
  await app.close();
});

test('紀錄：開始後寫進紀錄檔，停止後不再寫入', async () => {
  test.setTimeout(120_000);
  const { app, window, dialogs } = await openWithSession();

  const before = new Set(readdirSync(logDir).filter((f) => f.endsWith('.log')));

  await window.click('#btn-log');
  await expect(window.locator('#btn-log .btn-label')).toHaveText('紀錄中');
  await expect(window.locator('#btn-log')).toHaveClass(/on/);
  const row = window.locator('.session-item', { hasText: 'PowerShell 1' });
  await expect(row.locator('.session-state.logging')).toContainText('紀錄中');
  await expect(row.locator('.session-state .session-dot.logging')).toHaveCount(1);
  await shot(window, 'logging');

  await runInTerminal(window, 'echo LOG_MARK_123');
  await expect(activeRows(window)).toContainText('LOG_MARK_123', { timeout: 20_000 });
  await window.waitForTimeout(1500);

  await window.click('#btn-log');
  await expect(window.locator('#btn-log .btn-label')).toHaveText('紀錄');
  await expect(window.locator('#btn-log')).not.toHaveClass(/on/);
  await window.waitForTimeout(1000);

  const created = readdirSync(logDir)
    .filter((f) => f.endsWith('.log') && !before.has(f))
    .map((f) => ({ f, m: statSync(join(logDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  expect(created.length, `${logDir} 裡沒有出現新的 .log`).toBeGreaterThan(0);

  const logPath = join(logDir, created[0].f);
  expect(created[0].f).toContain('PowerShell 1-');
  const logged = stripAnsi(readFileSync(logPath, 'utf8'));
  expect(logged).toContain('LOG_MARK_123');

  // 停止之後就不該再寫進去
  await runInTerminal(window, 'echo AFTER_STOP');
  await expect(activeRows(window)).toContainText('AFTER_STOP', { timeout: 20_000 });
  await window.waitForTimeout(2000);
  const after = stripAnsi(readFileSync(logPath, 'utf8'));
  expect(after).not.toContain('AFTER_STOP');

  expect(dialogs).toEqual([]);
  await app.close();
});

test('清除畫面：畫面上的輸出被清掉', async () => {
  const { app, window, dialogs } = await openWithSession();

  await runInTerminal(window, 'echo CLEAR_MARK_9');
  await expect(activeRows(window)).toContainText('CLEAR_MARK_9', { timeout: 20_000 });

  await window.click('#btn-clear');
  await expect(activeRows(window)).not.toContainText('CLEAR_MARK_9');
  await shot(window, 'clear');

  expect(dialogs).toEqual([]);
  await app.close();
});
