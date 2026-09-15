import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { join } from 'node:path';
import { expectAlive, freshUserData, launchApp, root } from './helpers';

/** 這一份 spec 的重點就是「關掉再開還在」，所以 userData 只清一次。*/
const userData = freshUserData('cli-settings');

const FAKE_KEY = 'sk-e2e-fake-key-0000';

const shot = (window: Page, name: string) =>
  window.screenshot({ path: join(root, 'test-results', `cli-settings-${name}.png`) });

async function open(): Promise<{ app: ElectronApplication; window: Page; dialogs: string[] }> {
  const { app, window } = await launchApp(userData);
  const dialogs: string[] = [];
  window.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  return { app, window, dialogs };
}

/** 點頁尾那一行 (⚙ 也在裡面) 就打開「CLI 設定」。*/
async function openSettings(window: Page): Promise<void> {
  await window.click('#btn-cli-settings');
  await expect(window.locator('#cli-settings')).toBeVisible();
}

test('CLI 設定：存了 API 金鑰之後晶片換字，重開還在，清除之後回到原本的登入狀態', async () => {
  test.setTimeout(150_000);

  // 1. 存一把假金鑰
  const first = await open();
  await openSettings(first.window);
  // 還沒存過的時候提示字是「貼上 API 金鑰」。
  await expect(first.window.locator('#cli-claude-key')).toHaveAttribute(
    'placeholder',
    '貼上 API 金鑰',
  );
  // 探測結果先進來 (訂閱或未登入都行)，晶片上一定不是「API 金鑰」。
  await expect(first.window.locator('#cli-claude')).not.toContainText('API 金鑰');
  const before = (await first.window.locator('#cli-claude').textContent()) ?? '';

  await first.window.check('#cli-claude-mode-apiKey');
  await first.window.fill('#cli-claude-key', FAKE_KEY);
  await first.window.click('#cli-claude-save');

  await expect(first.window.locator('#cli-errors')).toHaveText('');
  await expect(first.window.locator('#cli-claude')).toHaveText('Claude · API 金鑰');
  await expect(first.window.locator('#cli-claude-status')).toHaveText('API 金鑰');
  // 存完之後那一格回到空的，只剩提示字 —— 金鑰不會被畫回畫面上。
  await expect(first.window.locator('#cli-claude-key')).toHaveValue('');
  await expect(first.window.locator('#cli-claude-key')).toHaveAttribute('placeholder', '已儲存');

  await shot(first.window, 'saved');
  await expectAlive(first.app, first.window);
  expect(first.dialogs).toEqual([]);
  await first.app.close();

  // 2. 重開：設定還在，金鑰格顯示「已儲存」
  const second = await open();
  await expect(second.window.locator('#cli-claude')).toHaveText('Claude · API 金鑰');
  await openSettings(second.window);
  await expect(second.window.locator('#cli-claude-mode-apiKey')).toBeChecked();
  await expect(second.window.locator('#cli-claude-key')).toHaveAttribute('placeholder', '已儲存');

  // 3. 清除金鑰：回到 CLI 自己的登入狀態
  await second.window.click('#cli-claude-clear');
  await expect(second.window.locator('#cli-claude-key')).toHaveAttribute(
    'placeholder',
    '貼上 API 金鑰',
  );
  await expect(second.window.locator('#cli-claude')).toHaveText(before);

  await shot(second.window, 'cleared');
  await expectAlive(second.app, second.window);
  expect(second.dialogs).toEqual([]);
  await second.app.close();
});

test('OpenCode 只有 API 金鑰，沒有「登入」；Muse 兩種基礎 shell 都選得到', async () => {
  const { app, window, dialogs } = await open();

  await openSettings(window);

  // OpenCode：沒有登入的單選鈕，也沒有「登入」按鈕。
  await expect(window.locator('#cli-opencode-mode-apiKey')).toBeChecked();
  await expect(window.locator('#cli-opencode-mode-login')).toHaveCount(0);
  await expect(window.locator('#cli-opencode-login')).toHaveCount(0);
  // 另外三支有。
  for (const id of ['claude', 'codex', 'muse']) {
    await expect(window.locator(`#cli-${id}-mode-login`)).toHaveCount(1);
    await expect(window.locator(`#cli-${id}-login`)).toHaveCount(1);
  }

  // 沒填金鑰就存：錯誤留在對話框裡，不會默默失敗。
  await window.click('#cli-opencode-save');
  await expect(window.locator('#cli-errors')).toHaveText('請輸入 API 金鑰');

  // 免費模型那一家不必金鑰：那一格收起來、型號自動填好，空著也存得進去。
  await window.selectOption('#cli-opencode-provider', 'opencode');
  await expect(window.locator('#cli-opencode-key-row')).toBeHidden();
  await expect(window.locator('#cli-opencode-model')).toHaveValue('mimo-v2.5-free');
  await window.click('#cli-opencode-save');
  await expect(window.locator('#cli-errors')).toHaveText('');

  await shot(window, 'opencode');
  await window.click('#cli-close');
  await expect(window.locator('#cli-settings')).toBeHidden();

  // Muse 在 Windows 上是原生執行，基礎 shell 兩種都選得到。
  await window.click('#btn-new');
  await window.selectOption('#f-type', 'muse');
  await expect(window.locator('#f-base-shell option[value="powershell"]')).not.toBeDisabled();
  await window.selectOption('#f-base-shell', 'powershell');
  await expect(window.locator('#f-base-shell')).toHaveValue('powershell');
  await window.click('#f-cancel');

  await expect(window.locator('.session-item')).toHaveCount(0);
  await expectAlive(app, window);
  expect(dialogs).toEqual([]);
  await app.close();
});
