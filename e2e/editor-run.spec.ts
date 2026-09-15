import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

/**
 * 畫布上的「執行檢視」：在畫布上拉一個 start → agent → 批准 → end，
 * 按「儲存並執行」之後**留在畫布上**看卡片上的狀態，從卡片切去看那個節點的
 * 終端機，再回畫布按卡片上的「批准」收尾。
 *
 * 用 opencode 的免費模型 (opencode/mimo-v2.5-free)，所以只需要網路、不需要金鑰。
 */
test.skip(
  !process.env.MYTERMINAL_AGENT_E2E_OPENCODE,
  '需要網路，用 OpenCode 免費模型，不需金鑰',
);

const userData = join(root, 'test-results', 'editor-run-user-data');
/** agent 真的會在這裡動檔案，所以給一個全新的目錄 (而且是真實長路徑)。*/
const workDir = join(root, 'test-results', 'editor-run-work');

const card = (id: string): string => `.wf-node[data-id="${id}"]`;
const out = (id: string, port?: string): string =>
  port === undefined ? `${card(id)} .wf-port.out` : `${card(id)} .wf-port.out[data-port="${port}"]`;
const inPort = (id: string): string => `${card(id)} .wf-port.in`;

/** 目前顯示中的那個終端機的文字。*/
const screenText = (window: Page): Promise<string> =>
  window
    .locator('.term-host:not([hidden]) .xterm-rows')
    .innerText()
    .catch(() => '');

test('畫布上看得到執行狀態、切得到節點的終端機、批准得了', async () => {
  // 冷啟動 + 一次真的模型呼叫，給很寬鬆的時間。
  test.setTimeout(300_000);

  for (const dir of [userData, workDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上前一次的 Electron 可能還鎖著目錄，留著也無妨。
    }
    mkdirSync(dir, { recursive: true });
  }

  const app: ElectronApplication = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: root,
    // 這台機器的 opencode 預設型號是內網 proxy 的模型 (會回 403)，指定免費那個。
    env: { ...defined(process.env), MYTERMINAL_OPENCODE_MODEL: 'opencode/mimo-v2.5-free' },
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 });
  });

  try {
    // 1. 在畫布上拉出 開始 → agent → 批准 → 結束
    await window.click('#btn-workflow-edit');
    await expect(window.locator('#workflow-editor')).toBeVisible();
    await window.click('#btn-add-agent');
    await window.click('#btn-add-approval');
    await dragNodeTo(window, 'agent-1', 260, 60);
    await dragNodeTo(window, 'approval-1', 500, 60);
    await dragNodeTo(window, 'end', 740, 60);

    await window.click(`${card('agent-1')} .wf-node-body`);
    await window.selectOption('#props-kind', 'opencode');
    await window.fill('#props-prompt', 'Reply with exactly RUNVIEW_OK');
    await window.fill('#props-cwd', '{{params.cwd}}');

    await window.click(`${card('approval-1')} .wf-node-body`);
    await window.fill('#props-question', '要收尾嗎？');

    await wire(window, out('start'), inPort('agent-1'));
    await wire(window, out('agent-1', 'ok'), inPort('approval-1'));
    await wire(window, out('approval-1', 'approved'), inPort('end'));
    await expect(window.locator('path.wf-edge')).toHaveCount(3);

    await window.fill('#editor-name', '畫布執行檢視');

    // 2. 儲存並執行：填完參數之後**留在畫布上**
    await window.click('#btn-editor-run');
    await expect(window.locator('#workflow-run')).toBeVisible();
    await window.fill('#w-task', '回一句話就好');
    // 短檔名 (ROBERT~1) 會被 CLI 當成可疑路徑，所以展開成真實長路徑。
    await window.fill('#w-cwd', realpathSync.native(workDir));
    await window.click('#w-ok');
    await expect(window.locator('#workflow-run')).toBeHidden();
    await expect(window.locator('#workflow-editor')).toBeVisible();

    // 3. 卡片上看得到狀態，編輯列上看得到這次執行的用量
    const runLine = window.locator(`${card('agent-1')} .wf-run-label`);
    await expect(runLine).toHaveText('執行中', { timeout: 60_000 });
    await expect(window.locator('#editor-run .workflow-status')).toHaveText('執行中');
    await expect(window.locator('#editor-run .workflow-cost')).toContainText('$');
    await window.screenshot({ path: join(root, 'test-results', 'editor-run-running.png') });

    await expect(runLine).toHaveText('完成', { timeout: 240_000 });
    await expect(window.locator(card('agent-1'))).toHaveAttribute('data-run-status', 'done');
    // 免費模型的 cost 是 0，所以節點上不會寫一個 $0.000 (見 opencodeEvents)。
    await expect(window.locator(`${card('agent-1')} .wf-run-cost`)).toHaveCount(0);

    // 4. 卡片上的「輸出」：切到那個節點的終端機
    await window.click(`${card('agent-1')} .wf-open-terminal`);
    await expect(window.locator('#workflow-editor')).toBeHidden();
    await expect.poll(() => screenText(window), { timeout: 60_000 }).toMatch(/^RUNVIEW_OK\s*$/m);
    await window.screenshot({ path: join(root, 'test-results', 'editor-run-terminal.png') });

    // 5. 回畫布：同一份工作流、覆蓋層還在
    await window.click('#btn-workflow-edit');
    await expect(window.locator('#workflow-editor')).toBeVisible();
    await expect(window.locator('#editor-name')).toHaveValue('畫布執行檢視');
    await expect(window.locator(`${card('agent-1')} .wf-run-label`)).toHaveText('完成');

    // 6. 屬性面板：跑起來的 agent 節點可以接手，也可以直接看輸出
    await window.click(`${card('agent-1')} .wf-node-body`);
    await expect(window.locator('#props-takeover')).toBeVisible();
    await window.click('#props-open-terminal');
    await expect(window.locator('#workflow-editor')).toBeHidden();
    await window.click('#btn-workflow-edit');
    await expect(window.locator('#workflow-editor')).toBeVisible();

    // 7. 批准節點的卡片上就有批准／退回
    await expect(window.locator(`${card('approval-1')} .wf-run-label`)).toHaveText('等待批准', {
      timeout: 60_000,
    });
    await expect(window.locator('#editor-run .workflow-status')).toHaveText('等待批准');
    await window.screenshot({ path: join(root, 'test-results', 'editor-run-waiting.png') });

    await expect(window.locator(`${card('approval-1')} .wf-reject`)).toHaveCount(1);
    await window.click(`${card('approval-1')} .wf-approve`);
    await expect(window.locator('#editor-run .workflow-status')).toHaveText('完成', {
      timeout: 60_000,
    });
    await expect(window.locator(`${card('end')} .wf-run-label`)).toHaveText('完成');
    await window.screenshot({ path: join(root, 'test-results', 'editor-run-done.png') });
  } finally {
    await app.close();
  }
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

/** 畫布座標 (0,0) 在螢幕上的位置 —— #editor-viewport 被 pan 平移過。*/
async function viewportOrigin(window: Page): Promise<{ x: number; y: number }> {
  const box = await window.locator('#editor-viewport').boundingBox();
  if (!box) throw new Error('量不到畫布的位置');
  return { x: box.x, y: box.y };
}

/** 把節點拖到指定的畫布座標；新節點一律排在最右邊，加完要自己排版。*/
async function dragNodeTo(window: Page, id: string, x: number, y: number): Promise<void> {
  const box = await window.locator(card(id)).boundingBox();
  if (!box) throw new Error(`量不到節點 ${id}`);
  const origin = await viewportOrigin(window);
  // 抓在標頭上 (左上角往內一點)，那裡沒有接點。
  const grabX = 40;
  const grabY = 8;
  await window.mouse.move(box.x + grabX, box.y + grabY);
  await window.mouse.down();
  await window.mouse.move(origin.x + x + grabX, origin.y + y + grabY, { steps: 6 });
  await window.mouse.up();
}

/** 把 process.env 裡沒有值的項目拿掉 (Playwright 的 env 只收字串)。*/
function defined(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) result[key] = value;
  return result;
}
