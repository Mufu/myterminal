import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { freshUserData, root } from './helpers';

/** 主題存在 localStorage，所以要有自己的 userData —— 不能動到開發機真正的設定。*/
const userData = freshUserData('theme');

/** 三種主題的工具列底色 (--chrome)，用來確認 CSS token 真的換掉了。*/
const CHROME = {
  dark: 'rgb(29, 33, 37)',
  light: 'rgb(253, 253, 253)',
  warm: 'rgb(26, 21, 16)',
};

const launch = () => electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root });

const toolbarBackground = (window: Page): Promise<string> =>
  window.locator('#toolbar').evaluate((el) => getComputedStyle(el).backgroundColor);

// 後面的測試靠前面留下來的 localStorage，必須照順序跑。
test.describe.configure({ mode: 'serial' });

test('切換到淺色主題會換掉 data-theme 與工具列底色', async () => {
  const app = await launch();
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
  const app = await launch();
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

test('切換到暖色主題：data-theme 變成 warm，工具列底色跟深色不一樣，重開還記得', async () => {
  const app = await launch();
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await toolbarBackground(window)).toBe(CHROME.dark);

  await window.selectOption('#theme-select', 'warm');
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'warm');
  const warm = await toolbarBackground(window);
  expect(warm).toBe(CHROME.warm);
  expect(warm).not.toBe(CHROME.dark);

  await window.screenshot({ path: join(root, 'test-results', 'theme-warm.png') });
  await app.close();

  // 重開之後還是暖色
  const again = await launch();
  const window2 = await again.firstWindow();
  await window2.waitForLoadState('domcontentloaded');
  await expect(window2.locator('html')).toHaveAttribute('data-theme', 'warm');
  await expect(window2.locator('#theme-select')).toHaveValue('warm');
  expect(await toolbarBackground(window2)).toBe(CHROME.warm);

  // 收尾：留下深色
  await window2.selectOption('#theme-select', 'dark');
  await expect(window2.locator('html')).toHaveAttribute('data-theme', 'dark');
  await again.close();
});
