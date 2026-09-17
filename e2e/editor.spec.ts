import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

/** 專用的 userData：這個測試會真的寫一份 workflows.json 出來。*/
const userData = join(root, 'test-results', 'editor-user-data');

/**
 * 畫布編輯器的端到端：拉一個 agent、接線、存起來，再確認執行對話框看得到它。
 * 全程不碰 claude / codex，所以不花錢，屬於預設的 npm run e2e。
 */
test('在畫布上拉出一個工作流並存起來', async () => {
  rmSync(userData, { recursive: true, force: true });
  mkdirSync(userData, { recursive: true });

  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  // 新節點預設放在最右邊那個節點的右側，1280 的預設視窗放不下，開大一點。
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 });
  });

  // 1. 打開畫布：新工作流只有開始與結束
  await window.click('#btn-workflow-edit');
  await expect(window.locator('#workflow-editor')).toBeVisible();
  await expect(window.locator('.wf-node')).toHaveCount(2);

  // 2. 加一個 agent，設角色與提示
  await window.click('#btn-add-agent');
  await expect(window.locator('.wf-node')).toHaveCount(3);
  await window.click('.wf-node[data-id="agent-1"] .wf-node-body');

  await window.selectOption('#props-role', 'coder');
  // 角色的預設權限會跟著跳過來
  await expect(window.locator('#props-permission')).toHaveValue('edit');
  await window.fill('#props-prompt', '{{params.task}}');
  await expect(window.locator('.wf-node[data-id="agent-1"] .role-tag')).toHaveText('工程師');

  // 還沒接線就存：驗證擋下來，錯誤顯示在畫布上
  await window.click('#btn-editor-save');
  await expect(window.locator('#editor-errors')).toBeVisible();
  await expect(window.locator('#editor-errors')).toContainText('從開始節點走不到');

  // 3. 接線：開始 → agent → 結束
  await wire(window, '.wf-node[data-id="start"] .wf-port.out', '.wf-node[data-id="agent-1"] .wf-port.in');
  await wire(
    window,
    '.wf-node[data-id="agent-1"] .wf-port.out[data-port="ok"]',
    '.wf-node[data-id="end"] .wf-port.in',
  );
  await expect(window.locator('path.wf-edge')).toHaveCount(2);

  // 4. 命名並儲存
  await window.fill('#editor-name', 'E2E 流程');
  await window.click('#btn-editor-save');
  await expect(window.locator('#editor-errors')).toBeHidden();
  await expect(window.locator('#btn-editor-delete')).toBeEnabled();

  await window.screenshot({ path: join(root, 'test-results', 'editor.png') });

  // 5. 回終端機，執行對話框的「自訂」分組裡看得到它
  await window.click('#btn-editor-close');
  await expect(window.locator('#workflow-editor')).toBeHidden();

  await window.click('#btn-workflow-run');
  await expect(window.locator('#workflow-run')).toBeVisible();
  await expect(
    window.locator('#w-template optgroup[label="自訂"] option', { hasText: 'E2E 流程' }),
  ).toHaveCount(1);

  await window.click('#w-cancel');
  await expect(window.locator('#workflow-run')).toBeHidden();

  await app.close();
});

/** 從一個接點拖到另一個接點：pointer 事件要有中間的移動才像真的拖曳。*/
async function wire(window: Page, fromSelector: string, toSelector: string): Promise<void> {
  const from = await centre(window, fromSelector);
  const to = await centre(window, toSelector);
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  await window.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await window.mouse.move(to.x, to.y, { steps: 5 });
  await window.mouse.up();
}

async function centre(window: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await window.locator(selector).boundingBox();
  if (!box) throw new Error(`量不到 ${selector} 的位置`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
