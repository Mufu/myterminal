import { test, expect, _electron as electron } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const exePath = join(root, 'dist', 'win-unpacked', 'myterminal.exe');

/**
 * 跟 smoke.spec.ts 同一套流程，但跑的是 electron-builder 打包出來的執行檔。
 * 目的是驗證 asar 外面的 node-pty（.node / conpty.dll / OpenConsole.exe）真的能用。
 */
test('打包後的執行檔也能開出 PowerShell', async () => {
  test.skip(!existsSync(exePath), 'run npm run dist first');

  const app = await electron.launch({ executablePath: exePath });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  await window.click('#btn-new');
  await expect(window.locator('#new-connection')).toBeVisible();
  await window.selectOption('#f-type', 'powershell');
  await window.click('#f-ok');

  await expect(window.locator('.xterm-rows')).toContainText('PS ', { timeout: 30_000 });
  await expect(window.locator('.session-item')).toHaveCount(1);

  await window.screenshot({ path: join(root, 'test-results', 'packaged.png') });
  await app.close();
});
