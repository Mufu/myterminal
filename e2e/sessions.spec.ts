import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { join } from 'node:path';
import { activeRows, expectAlive, freshUserData, launchApp, root, runInTerminal } from './helpers';

const userData = freshUserData('sessions');

const shot = (window: Page, name: string) =>
  window.screenshot({ path: join(root, 'test-results', `sessions-${name}.png`) });

/** 開一個工作階段：選類型、填該類型的欄位、按建立。*/
async function newSession(
  window: Page,
  type: string,
  fill: () => Promise<void> = async () => {},
): Promise<void> {
  await window.click('#btn-new');
  await expect(window.locator('#new-connection')).toBeVisible();
  await window.selectOption('#f-type', type);
  await fill();
  await window.click('#f-ok');
  await expect(window.locator('#new-connection')).toBeHidden();
}

/** 每個測試自己開一次 app，彼此不互相影響 (一次只有一個 Electron)。*/
async function open(): Promise<{ app: ElectronApplication; window: Page; dialogs: string[] }> {
  const { app, window } = await launchApp(userData);
  const dialogs: string[] = [];
  window.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  return { app, window, dialogs };
}

test('兩個 PowerShell：自動命名遞增，切換時只看得到自己的輸出', async () => {
  const { app, window, dialogs } = await open();

  await newSession(window, 'powershell');
  await expect(activeRows(window)).toContainText('PS ', { timeout: 30_000 });
  await runInTerminal(window, 'echo A_MARK_1');
  await expect(activeRows(window)).toContainText('A_MARK_1', { timeout: 15_000 });

  await newSession(window, 'powershell');
  await expect(activeRows(window)).toContainText('PS ', { timeout: 30_000 });
  await runInTerminal(window, 'echo B_MARK_2');
  await expect(activeRows(window)).toContainText('B_MARK_2', { timeout: 15_000 });

  // 自動命名
  await expect(window.locator('.session-item')).toHaveCount(2);
  await expect(window.locator('#session-count')).toHaveText('2');
  await expect(window.locator('.session-item .session-name').nth(0)).toHaveText('PowerShell 1');
  await expect(window.locator('.session-item .session-name').nth(1)).toHaveText('PowerShell 2');

  // 現在在 PowerShell 2：看不到 1 的標記
  await expect(activeRows(window)).not.toContainText('A_MARK_1');

  // 切回 PowerShell 1
  await window.locator('.session-item', { hasText: 'PowerShell 1' }).click();
  await expect(window.locator('.session-item', { hasText: 'PowerShell 1' })).toHaveClass(/active/);
  await expect(activeRows(window)).toContainText('A_MARK_1');
  await expect(activeRows(window)).not.toContainText('B_MARK_2');

  await shot(window, 'two-powershell');
  expect(dialogs).toEqual([]);
  await app.close();
});

test('WSL：預設發行版與指定 Ubuntu 都會進到 $ 提示字元，uname 看得到 Linux', async () => {
  test.setTimeout(150_000);
  const { app, window, dialogs } = await open();

  // 1. 發行版留空
  await newSession(window, 'wsl');
  await expect(activeRows(window)).toContainText('$', { timeout: 40_000 });
  await runInTerminal(window, 'uname -a');
  await expect(activeRows(window)).toContainText('Linux', { timeout: 20_000 });

  // 2. 指定 Ubuntu
  await newSession(window, 'wsl', async () => {
    await window.fill('#f-distro', 'Ubuntu');
  });
  await expect(activeRows(window)).toContainText('$', { timeout: 40_000 });
  await runInTerminal(window, 'uname -a');
  await expect(activeRows(window)).toContainText('Linux', { timeout: 20_000 });

  await expect(window.locator('.session-item')).toHaveCount(2);
  await shot(window, 'wsl');
  expect(dialogs).toEqual([]);
  await app.close();
});

test('自訂命令：cmd.exe 印出 CUSTOM_OK，那一列顯示已結束 (7)', async () => {
  const { app, window, dialogs } = await open();

  await newSession(window, 'custom', async () => {
    await window.fill('#f-file', 'cmd.exe');
    await window.fill('#f-args', '/c echo CUSTOM_OK && exit 7');
  });

  await expect(activeRows(window)).toContainText('CUSTOM_OK', { timeout: 20_000 });
  await expect(activeRows(window)).toContainText('[工作階段已結束]', { timeout: 20_000 });

  const row = window.locator('.session-item').first();
  await expect(row).toContainText('已結束 (7)');
  await expect(row).toHaveClass(/exited/);

  await shot(window, 'custom');
  expect(dialogs).toEqual([]);
  await app.close();
});

test('關閉執行中的 PowerShell：那一列消失、數量減一、畫面換到另一個工作階段', async () => {
  const { app, window, dialogs } = await open();

  await newSession(window, 'powershell');
  await expect(activeRows(window)).toContainText('PS ', { timeout: 30_000 });
  await runInTerminal(window, 'echo KEEP_ME_1');
  await expect(activeRows(window)).toContainText('KEEP_ME_1', { timeout: 15_000 });

  await newSession(window, 'powershell');
  await expect(activeRows(window)).toContainText('PS ', { timeout: 30_000 });
  await expect(window.locator('#session-count')).toHaveText('2');

  // 關掉還在跑的 PowerShell 2
  await window.locator('.session-item', { hasText: 'PowerShell 2' }).locator('.session-close').click();

  await expect(window.locator('.session-item')).toHaveCount(1);
  await expect(window.locator('#session-count')).toHaveText('1');
  await expect(window.locator('.session-item', { hasText: 'PowerShell 2' })).toHaveCount(0);
  // 畫面換到剩下的那個工作階段
  await expect(window.locator('#empty-hint')).toBeHidden();
  await expect(activeRows(window)).toContainText('KEEP_ME_1');

  // 再關掉最後一個 -> 空狀態提示
  await window.locator('.session-item').locator('.session-close').click();
  await expect(window.locator('.session-item')).toHaveCount(0);
  await expect(window.locator('#session-count')).toHaveText('0');
  await expect(window.locator('#empty-hint')).toBeVisible();

  await shot(window, 'closed');
  expect(dialogs).toEqual([]);
  await app.close();
});

test('Claude 互動工作階段：TUI 起得來，✕ 關得掉，app 還活著', async () => {
  test.setTimeout(150_000);
  const { app, window, dialogs } = await open();

  await newSession(window, 'claude', async () => {
    await window.selectOption('#f-base-shell', 'powershell');
  });

  // 不送任何提示，只等 TUI 畫出來 (v2 的橫幅一定有這一行)。
  await expect(activeRows(window)).toContainText(/Claude Code v\d/, { timeout: 120_000 });
  await shot(window, 'claude');

  await window.locator('.session-item', { hasText: 'Claude' }).locator('.session-close').click();
  await expect(window.locator('.session-item')).toHaveCount(0);
  await expect(window.locator('#empty-hint')).toBeVisible();

  await expectAlive(app, window);
  expect(dialogs).toEqual([]);
  await app.close();
});

test('Codex 互動工作階段：TUI 起得來，✕ 關得掉，app 還活著', async () => {
  test.setTimeout(150_000);
  const { app, window, dialogs } = await open();

  await newSession(window, 'codex', async () => {
    await window.selectOption('#f-base-shell', 'powershell');
  });

  // codex 起來之後可能直接是輸入框，也可能先問要不要更新；兩種都算起來了。
  // 不能只找 "codex" —— 那是 PowerShell 回顯的啟動指令，TUI 還沒起來就有了。
  await expect(activeRows(window)).toContainText(
    /Release notes|Press enter to continue|To get started/,
    { timeout: 120_000 },
  );
  await shot(window, 'codex');

  await window.locator('.session-item', { hasText: 'Codex' }).locator('.session-close').click();
  await expect(window.locator('.session-item')).toHaveCount(0);
  await expect(window.locator('#empty-hint')).toBeVisible();

  await expectAlive(app, window);
  expect(dialogs).toEqual([]);
  await app.close();
});
