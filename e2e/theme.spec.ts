import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { join } from 'node:path';

const root = join(__dirname, '..');

/** 深色與淺色的工具列底色 (--chrome)，用來確認 CSS token 真的換掉了。*/
const CHROME = {
  dark: 'rgb(29, 33, 37)',
  light: 'rgb(253, 253, 253)',
};

const toolbarBackground = (window: Page): Promise<string> =>
  window.locator('#toolbar').evaluate((el) => getComputedStyle(el).backgroundColor);

// 第二個測試靠第一個測試留下來的 localStorage，必須照順序跑。
test.describe.configure({ mode: 'serial' });

test('切換到淺色主題會換掉 data-theme 與工具列底色', async () => {
  const app = await electron.launch({ args: ['.'], cwd: root });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  await window.click('#btn-new');
  await expect(window.locator('#new-connection')).toBeVisible();
  await window.selectOption('#f-type', 'powershell');
  await window.click('#f-ok');
  await expect(window.locator('.xterm-rows')).toContainText('PS ', { timeout: 30_000 });

  await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');

  await window.selectOption('#theme-select', 'light');
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await toolbarBackground(window)).toBe(CHROME.light);

  await app.close();
});

test('重新啟動之後記得淺色主題，切回深色也會記住', async () => {
  const app = await electron.launch({ args: ['.'], cwd: root });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await toolbarBackground(window)).toBe(CHROME.light);
  await expect(window.locator('#theme-select')).toHaveValue('light');

  // 換回深色，之後的測試與截圖才會從深色開始。
  await window.selectOption('#theme-select', 'dark');
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await toolbarBackground(window)).toBe(CHROME.dark);

  await app.close();
});
