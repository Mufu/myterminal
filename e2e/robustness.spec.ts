import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { join } from 'node:path';
import { activeRows, expectAlive, freshUserData, launchApp, root, runInTerminal } from './helpers';

const userData = freshUserData('robustness');

const shot = (window: Page, name: string) =>
  window.screenshot({ path: join(root, 'test-results', `robustness-${name}.png`) });

async function open(): Promise<{ app: ElectronApplication; window: Page; dialogs: string[] }> {
  const { app, window } = await launchApp(userData);
  const dialogs: string[] = [];
  window.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  return { app, window, dialogs };
}

/** 開一個 PowerShell，等不等提示字元由呼叫端決定。*/
async function newPowerShell(window: Page): Promise<void> {
  await window.click('#btn-new');
  await window.selectOption('#f-type', 'powershell');
  await window.click('#f-ok');
}

const setBounds = (app: ElectronApplication, width: number, height: number) =>
  app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, ...size });
  }, { width, height });

test('視窗縮到很小再放大：不會跳出主行程的錯誤對話框，終端機還能用', async () => {
  test.setTimeout(120_000);
  const { app, window, dialogs } = await open();

  await newPowerShell(window);
  await expect(activeRows(window)).toContainText('PS ', { timeout: 30_000 });
  await newPowerShell(window);
  await expect(activeRows(window)).toContainText('PS ', { timeout: 30_000 });
  await expect(window.locator('.session-item')).toHaveCount(2);

  // 小到 xterm 幾乎量不出格子；FitAddon 這時候會算出 0 / NaN。
  await setBounds(app, 500, 300);
  await window.waitForTimeout(2000);
  await expectAlive(app, window);
  await shot(window, 'small');

  await setBounds(app, 1600, 1000);
  await window.waitForTimeout(2000);
  await expectAlive(app, window);

  // 放大之後還能打字，代表 pty 沒有被那次 resize 弄壞。
  await runInTerminal(window, 'echo RESIZE_OK');
  await expect(activeRows(window)).toContainText('RESIZE_OK', { timeout: 20_000 });
  await expect(window.locator('.session-item')).toHaveCount(2);
  await shot(window, 'large');

  expect(dialogs, `resize 期間跳出的對話框：${JSON.stringify(dialogs)}`).toEqual([]);
  await app.close();
});

test('連開六個 PowerShell 再全部關掉：每一個都有自己的終端機，最後回到空狀態', async () => {
  test.setTimeout(120_000);
  const { app, window, dialogs } = await open();

  for (let i = 0; i < 6; i += 1) await newPowerShell(window);

  await expect(window.locator('.session-item')).toHaveCount(6, { timeout: 30_000 });
  await expect(window.locator('#session-count')).toHaveText('6');
  // 一個工作階段一個終端機檢視，不能多也不能少。
  await expect(window.locator('.term-host')).toHaveCount(6);
  await expect(window.locator('.term-host:not([hidden])')).toHaveCount(1);
  await expect(activeRows(window)).toContainText('PS ', { timeout: 40_000 });
  await shot(window, 'six');

  for (let i = 6; i > 0; i -= 1) {
    await window.locator('.session-item .session-close').first().click();
    await expect(window.locator('.session-item')).toHaveCount(i - 1);
  }

  await expect(window.locator('#session-count')).toHaveText('0');
  await expect(window.locator('#empty-hint')).toBeVisible();
  await expect(window.locator('.term-host')).toHaveCount(0);
  await shot(window, 'empty');

  expect(dialogs).toEqual([]);
  await app.close();
});

test('還有兩個工作階段在跑的時候關視窗：app 會在 15 秒內結束', async () => {
  test.setTimeout(120_000);
  const { app, window } = await open();

  await newPowerShell(window);
  await expect(activeRows(window)).toContainText('PS ', { timeout: 30_000 });
  await newPowerShell(window);
  await expect(activeRows(window)).toContainText('PS ', { timeout: 30_000 });
  await expect(window.locator('.session-item')).toHaveCount(2);

  const closed = app.waitForEvent('close', { timeout: 15_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
});

test('在輸入區按 Delete：不會關掉工作階段，面板還在', async () => {
  const { app, window, dialogs } = await open();

  await newPowerShell(window);
  await expect(activeRows(window)).toContainText('PS ', { timeout: 30_000 });

  await window.click('#btn-input');
  await expect(window.locator('#input-panel')).toBeVisible();
  await window.fill('#input-text', 'DELETE_TEST');
  await window.locator('#input-text').press('Home');
  await window.locator('#input-text').press('Delete');

  await expect(window.locator('#input-panel')).toBeVisible();
  await expect(window.locator('#input-text')).toHaveValue('ELETE_TEST');
  await expect(window.locator('.session-item')).toHaveCount(1);
  await expect(window.locator('#session-count')).toHaveText('1');
  await shot(window, 'delete');

  expect(dialogs).toEqual([]);
  await expectAlive(app, window);
  await app.close();
});
