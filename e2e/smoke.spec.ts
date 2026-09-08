import { test, expect, _electron as electron } from '@playwright/test';
import { join } from 'node:path';

const root = join(__dirname, '..');

/**
 * 唯一的 E2E：啟動已建置的 app，用「新連接」開一個 PowerShell，
 * 等終端機出現 PS 提示字元後截圖到 test-results/smoke.png。
 */
test('用新連接開一個 PowerShell 並看到提示字元', async () => {
  const app = await electron.launch({ args: ['.'], cwd: root });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  await window.click('#btn-new');
  await expect(window.locator('#new-connection')).toBeVisible();
  await window.selectOption('#f-type', 'powershell');
  await window.click('#f-ok');

  // xterm.js 的 DOM renderer 會把每一列文字放進 .xterm-rows
  await expect(window.locator('.xterm-rows')).toContainText('PS ', { timeout: 30_000 });
  await expect(window.locator('.session-item')).toHaveCount(1);

  await window.screenshot({ path: join(root, 'test-results', 'smoke.png') });
  await app.close();
});
