import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '..');

/** 專用的 userData 目錄，確保測試不會動到開發機上真正的 profiles.json。*/
const userData = mkdtempSync(join(tmpdir(), 'myterminal-e2e-'));

const launch = (): Promise<ElectronApplication> =>
  electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root });

// 第二個測試靠第一個測試存下來的 profiles.json，必須照順序跑。
test.describe.configure({ mode: 'serial' });

test.afterAll(() => {
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    // Windows 上 Electron 剛結束時目錄可能還鎖著，留著也無妨。
  }
});

test('勾選「儲存此連線設定」時，工作階段與已儲存連線同時出現', async () => {
  const app = await launch();
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  // 建立 SSH 工作階段可能因為找不到 plink 而跳 alert，直接關掉。
  window.on('dialog', (dialog) => void dialog.dismiss());

  await expect(window.locator('.profile-empty')).toHaveText('尚無儲存的連線');

  await window.click('#btn-new');
  await window.selectOption('#f-type', 'powershell');
  await window.check('#f-save');

  // 勾了儲存卻沒填名稱：對話框不關，錯誤訊息出現。
  await window.click('#f-ok');
  await expect(window.locator('#new-connection')).toBeVisible();
  await expect(window.locator('#f-errors')).toHaveText('儲存設定時必須填名稱');
  await expect(window.locator('.session-item')).toHaveCount(0);

  await window.fill('#f-name', '我的 PS');
  await window.click('#f-ok');

  await expect(window.locator('.session-item')).toHaveCount(1);
  await expect(window.locator('.xterm-rows')).toContainText('PS ', { timeout: 30_000 });
  await expect(window.locator('#profile-list .profile-item')).toHaveCount(1);
  await expect(window.locator('#profile-list .profile-item')).toContainText('我的 PS');
  expect(existsSync(join(userData, 'profiles.json'))).toBe(true);

  // 第二筆設定檔，順便當截圖用的畫面。
  await window.click('#btn-new');
  await window.selectOption('#f-type', 'ssh');
  await window.fill('#f-name', '部署機');
  await window.fill('#f-host', 'build-server');
  await window.fill('#f-user', 'deploy');
  await window.check('#f-save');
  await window.click('#f-ok');

  await expect(window.locator('#profile-list .profile-item')).toHaveCount(2);
  await expect(window.locator('#profile-count')).toHaveText('2');
  await expect(
    window.locator('#profile-list .profile-item', { hasText: '部署機' }),
  ).toContainText('deploy@build-server');

  await window.screenshot({ path: join(root, 'test-results', 'profiles.png') });
  await app.close();
});

test('重新啟動後保留設定檔，點一下就連線，✕ 可以刪除', async () => {
  const app = await launch();
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  await expect(window.locator('#profile-list .profile-item')).toHaveCount(2);
  await expect(window.locator('#profile-list .profile-item').first()).toContainText('我的 PS');
  // 工作階段不會跟著留下來，只有設定檔會。
  await expect(window.locator('.session-item')).toHaveCount(0);

  await window.click('#profile-list .profile-item[data-name="我的 PS"]');
  await expect(window.locator('.session-item')).toHaveCount(1);
  await expect(window.locator('.session-item')).toContainText('我的 PS');
  await expect(window.locator('.xterm-rows')).toContainText('PS ', { timeout: 30_000 });

  // 這個 window 是 Playwright 的 Page，瀏覽器裡的 window 要用 globalThis 取。
  await window.evaluate(() => {
    globalThis.confirm = () => true;
  });

  await window.click('#profile-list .profile-item[data-name="我的 PS"] .profile-remove');
  await expect(window.locator('#profile-list .profile-item')).toHaveCount(1);

  await window.click('#profile-list .profile-item[data-name="部署機"] .profile-remove');
  await expect(window.locator('.profile-empty')).toHaveText('尚無儲存的連線');
  await expect(window.locator('#profile-count')).toHaveText('0');
  // 刪掉設定檔不會影響已經開著的工作階段。
  await expect(window.locator('.session-item')).toHaveCount(1);

  await app.close();
});
