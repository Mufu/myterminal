import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '..');

// 會真的呼叫 claude 兩次 (實作 + 審查)，要先登入，而且每跑一次都要付費。
test.skip(!process.env.MYTERMINAL_WORKFLOW_E2E, '需要已登入的 claude，會產生費用');

const TASK = '在工作目錄建立 hello.txt，內容只有一行 hello';

/** 兩次真的模型呼叫 + Electron 冷啟動，給很寬鬆的時間。*/
const MODEL_TIMEOUT = 480_000;

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), `myterminal-${prefix}-`));

interface Launched {
  app: ElectronApplication;
  window: Page;
}

async function launch(userData: string): Promise<Launched> {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}

/** 開「執行範本」對話框，填任務與工作目錄，按開始。*/
async function startTemplate(window: Page, cwd: string): Promise<void> {
  await window.click('#btn-workflow-run');
  await expect(window.locator('#workflow-run')).toBeVisible();
  await expect(window.locator('#w-template')).toHaveValue('implement-review-approve');
  await window.fill('#w-task', TASK);
  await window.fill('#w-cwd', cwd);
  await window.click('#w-ok');
  await expect(window.locator('#workflow-run')).not.toBeVisible();
}

const run = (window: Page) => window.locator('.workflow-run').first();
const status = (window: Page) => run(window).locator('.workflow-status');
const node = (window: Page, id: string) => run(window).locator(`.workflow-node[data-node="${id}"]`);

/** 目前顯示中的那個終端機的文字。*/
const screenText = (window: Page): Promise<string> =>
  window
    .locator('.term-host:not([hidden]) .xterm-rows')
    .innerText()
    .catch(() => '');

test('執行範本跑到等待批准，批准之後完成並留下檔案', async () => {
  test.setTimeout(900_000);
  const work = temp('workflow-cwd');
  const { app, window } = await launch(temp('workflow-e2e'));

  try {
    await expect(window.locator('.workflow-empty')).toHaveText('尚無工作流執行');
    await startTemplate(window, work);

    await expect(status(window)).toHaveText('執行中', { timeout: 30_000 });
    await expect(node(window, 'implement').locator('.session-dot')).toHaveClass(/running/, {
      timeout: 60_000,
    });

    // 實作 → 審查 → 檢查，審查過了才會停在批准。
    await expect(status(window)).toHaveText('等待批准', { timeout: MODEL_TIMEOUT });
    await expect(run(window).locator('.workflow-question')).toHaveText('要保留這次的變更嗎？');
    await expect(node(window, 'implement').locator('.session-dot')).toHaveClass(/done/);
    await expect(node(window, 'review').locator('.session-dot')).toHaveClass(/done/);
    await expect(node(window, 'approve').locator('.session-dot')).toHaveClass(/waiting/);

    // 兩個 agent 節點各自是一個普通的工作階段。
    // (審查沒過的話還會多出「修正」與第二次「審查」，所以只看前兩個。)
    const sessions = window.locator('.session-item');
    await expect(sessions.nth(0)).toContainText('· 實作');
    await expect(sessions.nth(1)).toContainText('· 審查');
    expect(await sessions.count()).toBeGreaterThanOrEqual(2);

    await window.screenshot({ path: join(root, 'test-results', 'workflow.png') });

    // 點節點那一列就切到那個節點的終端機。
    await node(window, 'implement').click();
    await expect.poll(() => screenText(window), { timeout: 20_000 }).toContain('[claude] 任務：');

    await run(window).locator('.workflow-approve').click();
    await expect(status(window)).toHaveText('完成', { timeout: 60_000 });
    await expect(node(window, 'end').locator('.session-dot')).toHaveClass(/done/);
    // 「修正」要嘛沒走到 (略過)，要嘛走過一輪之後審查才過 —— 兩種都算正常。
    await expect(node(window, 'fix').locator('.session-dot')).toHaveClass(/skipped|done/);

    expect(existsSync(join(work, 'hello.txt'))).toBe(true);
  } finally {
    await app.close();
  }
});

test('等待批准的執行在 app 重啟之後仍然批得下去', async () => {
  test.setTimeout(900_000);
  const userData = temp('workflow-e2e');
  const work = temp('workflow-cwd');

  const first = await launch(userData);
  await startTemplate(first.window, work);
  await expect(status(first.window)).toHaveText('等待批准', { timeout: MODEL_TIMEOUT });
  await first.app.close();

  // 重開：checkpoint 在 userData/workflow-runs/<runId>.json，摘要在 workflow-runs.json。
  const second = await launch(userData);
  try {
    await expect(status(second.window)).toHaveText('等待批准', { timeout: 30_000 });
    await expect(run(second.window).locator('.workflow-question')).toHaveText(
      '要保留這次的變更嗎？',
    );
    // 工作階段不會跟著留下來 (CLI 早就跑完了)，但節點狀態留著。
    await expect(second.window.locator('.session-item')).toHaveCount(0);
    await expect(node(second.window, 'review').locator('.session-dot')).toHaveClass(/done/);

    await run(second.window).locator('.workflow-approve').click();
    await expect(status(second.window)).toHaveText('完成', { timeout: 60_000 });
    expect(existsSync(join(work, 'hello.txt'))).toBe(true);
  } finally {
    await second.app.close();
  }
});
