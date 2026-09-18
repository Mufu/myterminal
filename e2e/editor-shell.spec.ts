import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findRole } from '../src/shared/roles';
import { pickRole } from './helpers';

const root = join(__dirname, '..');

/**
 * 畫布上的「手動操作」：不跑無介面的執行，而是直接在節點的工作目錄開一個
 * 互動式終端機自己下 prompt。全程不送任何提示給 CLI，所以不花錢
 * （Claude 只是把 TUI 叫起來，看到橫幅就關掉）。
 */

const card = (id: string): string => `.wf-node[data-id="${id}"]`;

/** 一個案例一份乾淨的 userData。*/
function userDataFor(name: string): string {
  const dir = join(root, 'test-results', `editor-shell-${name}`);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 上前一次的 Electron 可能還鎖著目錄，留著也無妨。
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function launch(userData: string): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 });
  });
  return { app, window };
}

const shot = (window: Page, name: string): Promise<Buffer> =>
  window.screenshot({ path: join(root, 'test-results', `editor-shell-${name}.png`) });

test('節點的手動操作：開終端機、複製提示、開終端機並啟動 CLI', async () => {
  // Claude 的 TUI 冷啟動很慢，給寬鬆的時間。
  test.setTimeout(240_000);
  const userData = userDataFor('manual');
  // 短檔名 (ROBERT~1) 會被 CLI 當成可疑路徑，一律用真實長路徑。
  const workDir = join(root, 'test-results', 'shell-cwd');
  mkdirSync(workDir, { recursive: true });
  const realWorkDir = realpathSync.native(workDir);

  const { app, window } = await launch(userData);
  try {
    // 1. 畫布上放一個 agent 節點，工作目錄寫死成那個目錄
    await window.click('#btn-workflow-edit');
    await expect(window.locator('#workflow-editor')).toBeVisible();
    await window.click('#btn-add-agent');
    await window.click(`${card('agent-1')} .wf-node-body`);

    await window.fill('#props-cwd', realWorkDir);
    await window.fill('#props-prompt', '請說 SHELL_OK');
    await pickRole(window, '#props-role-pick', '工程師', '工程師');
    // 工程師的預設權限是可修改檔案。
    await expect(window.locator('#props-permission')).toHaveValue('edit');
    // 預設在 PowerShell 裡開。
    await expect(window.locator('#props-shell')).toHaveValue('powershell');
    // 選起來的卡片上也有同一組動作。
    await expect(window.locator(`${card('agent-1')} .wf-open-shell`)).toBeVisible();
    await shot(window, 'props');

    // 2. 「開終端機」：那個目錄的 PowerShell
    await window.click('#props-open-shell');
    await expect(window.locator('#workflow-editor')).toBeHidden();
    await expect(window.locator('.session-item', { hasText: '新工作流 · Agent shell' })).toHaveCount(
      1,
    );
    await expect(window.locator('.term-host:not([hidden]) .xterm-rows')).toContainText(
      realWorkDir,
      { timeout: 60_000 },
    );
    await shot(window, 'shell');

    // 3. 回畫布：「複製提示」是代好的提示，前面帶著角色的前置指示
    await window.click('#btn-workflow-edit');
    await expect(window.locator('#workflow-editor')).toBeVisible();
    await window.click(`${card('agent-1')} .wf-node-body`);
    await window.click('#props-copy-prompt');
    const prompt = `${findRole('coder')?.systemPrompt}\n\n請說 SHELL_OK`;
    // 寫進剪貼簿是非同步的（CopyNodePromptCommand 的 await），點完不一定馬上讀得到，
    // 所以要等 —— 直接讀會偶爾拿到上一次的內容。
    // Windows 的剪貼簿把換行正規化成 CRLF。
    await expect
      .poll(
        async () =>
          (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n'),
        { timeout: 5_000 },
      )
      .toBe(prompt);

    // 4. 「開終端機並啟動 Claude」：TUI 起來，提示填進「輸入字」面板但沒送出
    await expect(window.locator('#props-open-cli')).toHaveText('開終端機並啟動 Claude');
    await window.click('#props-open-cli');
    await expect(window.locator('#workflow-editor')).toBeHidden();
    await expect(
      window.locator('.session-item', { hasText: '新工作流 · Agent Claude' }),
    ).toHaveCount(1);
    await expect(window.locator('#input-panel')).toBeVisible();
    await expect(window.locator('#input-text')).toHaveValue(prompt);

    // 提示留在面板裡等人自己按送出，這裡不打任何字給 Claude。
    await expect(window.locator('.term-host:not([hidden]) .xterm-rows')).toContainText(
      /Claude Code v\d/,
      { timeout: 180_000 },
    );
    await shot(window, 'cli');

    await window
      .locator('.session-item', { hasText: '新工作流 · Agent Claude' })
      .locator('.session-close')
      .click();
    await expect(window.locator('.session-item', { hasText: 'Claude' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('工作目錄代不出來時先問一次，取消就什麼都不開', async () => {
  test.setTimeout(120_000);
  const userData = userDataFor('ask-cwd');
  const { app, window } = await launch(userData);

  try {
    await window.click('#btn-workflow-edit');
    await window.click('#btn-add-agent');
    await window.click(`${card('agent-1')} .wf-node-body`);
    // 新節點的預設工作目錄就是 {{params.cwd}}，而這份工作流還沒跑過。
    await expect(window.locator('#props-cwd')).toHaveValue('{{params.cwd}}');

    await window.click('#props-open-shell');
    await expect(window.locator('#cwd-prompt')).toBeVisible();
    await shot(window, 'ask-cwd');

    await window.click('#cwd-cancel');
    await expect(window.locator('#cwd-prompt')).toBeHidden();
    // 一個工作階段都沒開，也還留在畫布上。
    await expect(window.locator('.session-item')).toHaveCount(0);
    await expect(window.locator('#workflow-editor')).toBeVisible();
  } finally {
    await app.close();
  }
});
