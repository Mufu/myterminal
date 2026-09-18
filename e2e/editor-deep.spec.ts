import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATES } from '../src/main/workflow/templates';

const root = join(__dirname, '..');

/**
 * 畫布編輯器的深度端到端：範本副本、改接、刪節點連帶清參照、屬性往返、
 * 驗證訊息、儲存並執行、回終端機、未存變更的守門、執行對話框的驗證與持久化。
 * 全程不呼叫 claude / codex，所以不花錢。
 */

interface Definition {
  version: 1;
  id: string;
  name: string;
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    position: { x: number; y: number };
    config?: Record<string, unknown>;
  }>;
  edges: Array<{ from: string; to: string; port?: string }>;
}

interface Launched {
  app: ElectronApplication;
  window: Page;
}

/** 一個案例一份乾淨的 userData，工作流才不會互相污染。*/
function userDataFor(name: string): string {
  const dir = join(root, 'test-results', `editor-deep-${name}`);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 上前一次的 Electron 可能還鎖著目錄，留著也無妨。
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 先放一份自訂工作流進去再開 app：省掉在畫布上拉的步驟。*/
function seed(userData: string, definitions: Definition[]): void {
  writeFileSync(join(userData, 'workflows.json'), JSON.stringify(definitions, null, 2), 'utf8');
}

function storedWorkflows(userData: string): Definition[] {
  try {
    return JSON.parse(readFileSync(join(userData, 'workflows.json'), 'utf8')) as Definition[];
  } catch {
    return [];
  }
}

/** 新節點預設放在最右邊那個節點的右側，1280 的預設視窗放不下，開大一點。*/
async function launch(userData: string): Promise<Launched> {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 });
  });
  return { app, window };
}

const out = (id: string, port?: string): string =>
  port === undefined
    ? `.wf-node[data-id="${id}"] .wf-port.out`
    : `.wf-node[data-id="${id}"] .wf-port.out[data-port="${port}"]`;
const inPort = (id: string): string => `.wf-node[data-id="${id}"] .wf-port.in`;
const card = (id: string): string => `.wf-node[data-id="${id}"]`;

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

/**
 * 把節點拖到指定的畫布座標。新節點一律放在最右邊那個的右側，
 * 加到第三個就超出可視範圍了，所以加完要自己排版。
 */
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

/** 點在第 index 條連線的中點上把它選起來 (感應範圍是那條隱形的粗線)。*/
async function selectEdge(window: Page, index: number): Promise<void> {
  const point = await window.evaluate((i: number) => {
    const paths = Array.from(document.querySelectorAll('path.wf-edge-hit')) as SVGPathElement[];
    const path = paths[i];
    const mid = path.getPointAtLength(path.getTotalLength() / 2);
    const rect = (document.getElementById('editor-viewport') as HTMLElement).getBoundingClientRect();
    return { x: rect.left + mid.x, y: rect.top + mid.y };
  }, index);
  await window.mouse.click(point.x, point.y);
}

/** 目前顯示中的那個終端機的文字。*/
const screenText = (window: Page): Promise<string> =>
  window
    .locator('.term-host:not([hidden]) .xterm-rows')
    .innerText()
    .catch(() => '');

const shot = (window: Page, name: string): Promise<Buffer> =>
  window.screenshot({ path: join(root, 'test-results', `editor-deep-${name}.png`) });

// ---- 1. 內建範本 ----

test('內建範本：載入、另存副本、範本不變、刪掉副本', async () => {
  const userData = userDataFor('template');
  const { app, window } = await launch(userData);
  window.on('dialog', (dialog) => void dialog.accept());

  try {
    await window.click('#btn-workflow-edit');
    await expect(window.locator('#workflow-editor')).toBeVisible();

    await window.selectOption('#editor-workflow', 'implement-review-approve');
    await expect(window.locator('.wf-node')).toHaveCount(7);
    await expect(window.locator('path.wf-edge')).toHaveCount(7);
    await expect(window.locator('#editor-name')).toHaveValue('實作 → 審查 → 批准');
    // 內建範本刪不得。
    await expect(window.locator('#btn-editor-delete')).toBeDisabled();

    // 改名字再存 -> 變成一份新的自訂工作流 (id 不同、名字多了「 (副本)」)。
    await window.fill('#editor-name', '深度測試');
    await window.click('#btn-editor-save');
    await expect(window.locator('#editor-errors')).toBeHidden();
    await expect(window.locator('#btn-editor-delete')).toBeEnabled();
    await expect(window.locator('#editor-name')).toHaveValue('深度測試 (副本)');

    const copyId = await window.locator('#editor-workflow').inputValue();
    expect(copyId).not.toBe('implement-review-approve');
    const saved = storedWorkflows(userData);
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(copyId);
    expect(saved[0].name).toBe('深度測試 (副本)');
    expect(saved[0].nodes).toHaveLength(7);
    expect(saved[0].edges).toHaveLength(7);

    // 範本自己沒被改到。
    await window.selectOption('#editor-workflow', 'implement-review-approve');
    await expect(window.locator('#editor-name')).toHaveValue('實作 → 審查 → 批准');
    await expect(window.locator('#btn-editor-delete')).toBeDisabled();

    await shot(window, 'template-copy');

    // 刪掉副本：下拉選單與執行對話框都要看不到它。
    await window.selectOption('#editor-workflow', copyId);
    await expect(window.locator('#btn-editor-delete')).toBeEnabled();
    await window.click('#btn-editor-delete');
    await expect(window.locator(`#editor-workflow option[value="${copyId}"]`)).toHaveCount(0);
    expect(storedWorkflows(userData)).toHaveLength(0);

    await window.click('#btn-editor-close');
    await window.click('#btn-workflow-run');
    await expect(window.locator('#workflow-run')).toBeVisible();
    await expect(window.locator(`#w-template option[value="${copyId}"]`)).toHaveCount(0);
    await window.click('#w-cancel');
  } finally {
    await app.close();
  }
});

// ---- 2. 改接 ----

test('同一個出口再拉一次是改接，不是多一條線', async () => {
  const userData = userDataFor('rewire');
  const { app, window } = await launch(userData);

  try {
    await window.click('#btn-workflow-edit');
    await window.click('#btn-add-agent');
    await dragNodeTo(window, 'agent-1', 260, 300);

    await wire(window, out('start'), inPort('agent-1'));
    await expect(window.locator('path.wf-edge')).toHaveCount(1);

    await wire(window, out('start'), inPort('end'));
    // 出口只能有一條線：第二次是改接。
    await expect(window.locator('path.wf-edge')).toHaveCount(1);

    await selectEdge(window, 0);
    await expect(window.locator('#editor-props .props-title')).toHaveText('連線：start（—）→ end');
    await shot(window, 'rewire');
  } finally {
    await app.close();
  }
});

// ---- 3. 刪節點連帶清掉連線與參照 ----

test('刪掉節點會一起清掉連線、condition 的來源與 resumeFrom', async () => {
  const userData = userDataFor('delete-node');
  const { app, window } = await launch(userData);

  try {
    await window.click('#btn-workflow-edit');
    await window.click('#btn-add-agent');
    await dragNodeTo(window, 'agent-1', 250, 60);
    await window.click('#btn-add-agent');
    await dragNodeTo(window, 'agent-2', 250, 280);
    await window.click('#btn-add-condition');
    await dragNodeTo(window, 'condition-1', 470, 60);

    await wire(window, out('start'), inPort('agent-1'));
    await wire(window, out('agent-1', 'ok'), inPort('condition-1'));
    await expect(window.locator('path.wf-edge')).toHaveCount(2);

    // condition 看 agent-1 的輸出，agent-2 接續 agent-1 的對話。
    await window.click(`${card('condition-1')} .wf-node-body`);
    await window.selectOption('#props-source', 'agent-1');
    await window.click(`${card('agent-2')} .wf-node-body`);
    await window.selectOption('#props-resume-from', 'agent-1');
    await expect(window.locator('#props-resume-from')).toHaveValue('agent-1');

    // 選起 agent-1 按 Delete。
    await window.click(`${card('agent-1')} .wf-node-body`);
    await expect(window.locator(`${card('agent-1')}.selected`)).toHaveCount(1);
    await window.keyboard.press('Delete');

    await expect(window.locator('.wf-node')).toHaveCount(4);
    await expect(window.locator(card('agent-1'))).toHaveCount(0);
    await expect(window.locator('path.wf-edge')).toHaveCount(0);

    await window.click(`${card('condition-1')} .wf-node-body`);
    await expect(window.locator('#props-source')).toHaveValue('');
    await window.click(`${card('agent-2')} .wf-node-body`);
    await expect(window.locator('#props-resume-from')).toHaveValue('');
  } finally {
    await app.close();
  }
});

// ---- 4. 在輸入框裡按 Delete 不能刪節點 ----

test('游標在提示欄位裡時按 Delete 不會刪掉節點', async () => {
  const userData = userDataFor('delete-key');
  const { app, window } = await launch(userData);

  try {
    await window.click('#btn-workflow-edit');
    await window.click('#btn-add-agent');
    await window.click(`${card('agent-1')} .wf-node-body`);

    await window.fill('#props-prompt', '不要刪我');
    await window.locator('#props-prompt').press('Delete');
    await window.locator('#props-prompt').press('Backspace');

    await expect(window.locator('.wf-node')).toHaveCount(3);
    await expect(window.locator(card('agent-1'))).toHaveCount(1);
  } finally {
    await app.close();
  }
});

// ---- 5. condition / approval 的屬性存得下來也讀得回來 ----

const ROUND_TRIP: Definition = {
  version: 1,
  id: 'wf-roundtrip',
  name: '往返測試',
  nodes: [
    { id: 'start', type: 'start', label: '開始', position: { x: 40, y: 120 } },
    {
      id: 'agent-1',
      type: 'agent',
      label: 'Agent',
      position: { x: 240, y: 120 },
      config: { kind: 'claude', prompt: '{{params.task}}', cwd: '{{params.cwd}}', permission: 'readonly' },
    },
    {
      id: 'condition-1',
      type: 'condition',
      label: '條件',
      position: { x: 440, y: 120 },
      config: { source: 'agent-1', rule: { type: 'lastLineEquals', value: 'DONE' } },
    },
    {
      id: 'approval-1',
      type: 'approval',
      label: '批准',
      position: { x: 640, y: 120 },
      config: { question: '舊問題' },
    },
    { id: 'end', type: 'end', label: '結束', position: { x: 840, y: 120 } },
  ],
  edges: [
    { from: 'start', to: 'agent-1' },
    { from: 'agent-1', to: 'condition-1', port: 'ok' },
    { from: 'condition-1', to: 'approval-1', port: 'yes' },
    { from: 'condition-1', to: 'end', port: 'no' },
    { from: 'approval-1', to: 'end', port: 'approved' },
  ],
};

test('條件與批准的設定存得下來，重開 app 之後還在', async () => {
  test.setTimeout(120_000);
  const userData = userDataFor('round-trip');
  seed(userData, [ROUND_TRIP]);

  const first = await launch(userData);
  try {
    await first.window.click('#btn-workflow-edit');
    await first.window.selectOption('#editor-workflow', 'wf-roundtrip');
    await expect(first.window.locator('.wf-node')).toHaveCount(5);

    await first.window.click(`${card('condition-1')} .wf-node-body`);
    await first.window.selectOption('#props-rule', 'regex');
    await first.window.fill('#props-rule-value', '^OK-[0-9]+$');

    await first.window.click(`${card('approval-1')} .wf-node-body`);
    await first.window.fill('#props-question', '要收下這次的變更嗎？');

    await first.window.click('#btn-editor-save');
    await expect(first.window.locator('#editor-errors')).toBeHidden();

    const saved = storedWorkflows(userData).find((d) => d.id === 'wf-roundtrip');
    expect(saved?.nodes.find((n) => n.id === 'condition-1')?.config).toEqual({
      source: 'agent-1',
      rule: { type: 'regex', pattern: '^OK-[0-9]+$' },
    });
    expect(saved?.nodes.find((n) => n.id === 'approval-1')?.config).toEqual({
      question: '要收下這次的變更嗎？',
    });
  } finally {
    await first.app.close();
  }

  const second = await launch(userData);
  try {
    await second.window.click('#btn-workflow-edit');
    await second.window.selectOption('#editor-workflow', 'wf-roundtrip');

    await second.window.click(`${card('condition-1')} .wf-node-body`);
    await expect(second.window.locator('#props-rule')).toHaveValue('regex');
    await expect(second.window.locator('#props-rule-value')).toHaveValue('^OK-[0-9]+$');
    await expect(second.window.locator('#props-source')).toHaveValue('agent-1');

    await second.window.click(`${card('approval-1')} .wf-node-body`);
    await expect(second.window.locator('#props-question')).toHaveValue('要收下這次的變更嗎？');
  } finally {
    await second.app.close();
  }
});

// ---- 6. 驗證訊息 ----

test('兩個孤兒節點各報一條錯，接起來之後錯誤消失', async () => {
  const userData = userDataFor('validate');
  const { app, window } = await launch(userData);

  try {
    await window.click('#btn-workflow-edit');
    await window.click('#btn-add-agent');
    await dragNodeTo(window, 'agent-1', 250, 60);
    // 提示是必填的，先填好，這個案例要看的是孤兒節點的錯誤。
    await window.click(`${card('agent-1')} .wf-node-body`);
    await window.fill('#props-prompt', '{{params.task}}');
    await window.click('#btn-add-approval');
    await dragNodeTo(window, 'approval-1', 470, 60);

    await window.click('#btn-editor-save');
    await expect(window.locator('#editor-errors')).toBeVisible();
    await expect(window.locator('#editor-errors')).toContainText('節點 agent-1 從開始節點走不到');
    await expect(window.locator('#editor-errors')).toContainText('節點 approval-1 從開始節點走不到');
    expect(storedWorkflows(userData)).toHaveLength(0);
    await shot(window, 'validate');

    await wire(window, out('start'), inPort('agent-1'));
    await wire(window, out('agent-1', 'ok'), inPort('approval-1'));
    await wire(window, out('approval-1', 'approved'), inPort('end'));
    await window.fill('#editor-name', '接好了');
    await window.click('#btn-editor-save');

    await expect(window.locator('#editor-errors')).toBeHidden();
    expect(storedWorkflows(userData)).toHaveLength(1);
  } finally {
    await app.close();
  }
});

// ---- 7. 儲存並執行 ----

test('儲存並執行會打開執行對話框並預選剛存好的工作流', async () => {
  const userData = userDataFor('save-and-run');
  const { app, window } = await launch(userData);

  try {
    await window.click('#btn-workflow-edit');
    await window.click('#btn-add-agent');
    await dragNodeTo(window, 'agent-1', 300, 120);
    await window.click(`${card('agent-1')} .wf-node-body`);
    await window.fill('#props-prompt', '{{params.task}}');
    await wire(window, out('start'), inPort('agent-1'));
    await wire(window, out('agent-1', 'ok'), inPort('end'));
    await window.fill('#editor-name', '儲存並執行');
    await window.click('#btn-editor-save');
    await expect(window.locator('#editor-errors')).toBeHidden();

    const id = await window.locator('#editor-workflow').inputValue();
    expect(id).not.toBe('');

    await window.click('#btn-editor-run');
    await expect(window.locator('#workflow-run')).toBeVisible();
    await expect(window.locator('#w-template')).toHaveValue(id);

    await window.click('#w-cancel');
    await expect(window.locator('#workflow-run')).toBeHidden();
  } finally {
    await app.close();
  }
});

// ---- 8. 回終端機 ----

test('進畫布再回終端機，PowerShell 還活著也還是滿版的', async () => {
  test.setTimeout(120_000);
  const userData = userDataFor('back-to-terminal');
  const { app, window } = await launch(userData);

  try {
    await window.click('#btn-new');
    await window.selectOption('#f-type', 'powershell');
    await window.click('#f-ok');
    await expect(window.locator('.xterm-rows')).toContainText('PS ', { timeout: 30_000 });

    const before = await window.locator('.term-host:not([hidden])').boundingBox();
    expect(before?.width ?? 0).toBeGreaterThan(200);

    await window.click('#btn-workflow-edit');
    await expect(window.locator('#workflow-editor')).toBeVisible();
    await window.click('#btn-add-agent');
    await window.click('#btn-editor-close');
    await expect(window.locator('#workflow-editor')).toBeHidden();

    // 尺寸回來了 (不是 0 寬)，提示字元也還看得到。
    const after = await window.locator('.term-host:not([hidden])').boundingBox();
    expect(after?.width ?? 0).toBeGreaterThan(200);
    expect(after?.height ?? 0).toBeGreaterThan(100);
    await expect(window.locator('.term-host:not([hidden]) .xterm-rows')).toContainText('PS ');

    // 還打得動：輸入的那一行會帶著提示字元，所以要求輸出自己獨佔一行。
    await window.locator('.term-host:not([hidden]) .xterm-screen').click();
    await window.keyboard.type('echo BACK_OK');
    await window.keyboard.press('Enter');
    await expect.poll(() => screenText(window), { timeout: 30_000 }).toMatch(/^BACK_OK\s*$/m);

    await shot(window, 'back-to-terminal');
  } finally {
    await app.close();
  }
});

// ---- 9. 未存變更的守門 ----

test('畫布有沒存的東西時換工作流會先問一次', async () => {
  const userData = userDataFor('dirty-guard');
  const { app, window } = await launch(userData);

  let answer: 'accept' | 'dismiss' = 'dismiss';
  const messages: string[] = [];
  window.on('dialog', (dialog) => {
    messages.push(dialog.message());
    void (answer === 'accept' ? dialog.accept() : dialog.dismiss());
  });

  try {
    await window.click('#btn-workflow-edit');
    await window.click('#btn-add-agent');
    await expect(window.locator('.wf-node')).toHaveCount(3);

    // 取消：留在原本那一份 (agent 還在)。
    await window.selectOption('#editor-workflow', 'implement-review-approve');
    await expect.poll(() => messages.length, { timeout: 5_000 }).toBe(1);
    expect(messages[0]).toContain('還沒儲存');
    await expect(window.locator('.wf-node')).toHaveCount(3);
    await expect(window.locator(card('agent-1'))).toHaveCount(1);

    // 確定：換過去。
    answer = 'accept';
    await window.selectOption('#editor-workflow', 'implement-review-approve');
    await expect(window.locator('.wf-node')).toHaveCount(7);
    await expect(window.locator('#editor-name')).toHaveValue('實作 → 審查 → 批准');
  } finally {
    await app.close();
  }
});

// ---- 10. 執行對話框的驗證 ----

test('執行對話框：任務或工作目錄沒填就不讓開始', async () => {
  const userData = userDataFor('run-validation');
  const { app, window } = await launch(userData);

  try {
    await window.click('#btn-workflow-run');
    await expect(window.locator('#workflow-run')).toBeVisible();

    await window.click('#w-ok');
    await expect(window.locator('#workflow-run')).toBeVisible();
    await expect(window.locator('#w-errors')).toContainText('請輸入任務');
    await expect(window.locator('#w-errors')).toContainText('請輸入工作目錄');

    await window.fill('#w-task', '隨便做點什麼');
    await window.click('#w-ok');
    await expect(window.locator('#workflow-run')).toBeVisible();
    await expect(window.locator('#w-errors')).toHaveText('請輸入工作目錄');

    await window.fill('#w-task', '   ');
    await window.fill('#w-cwd', join(root, 'test-results'));
    await window.click('#w-ok');
    await expect(window.locator('#workflow-run')).toBeVisible();
    await expect(window.locator('#w-errors')).toHaveText('請輸入任務');

    // 一個工作流都沒真的跑起來。
    await expect(window.locator('.workflow-empty')).toHaveText('尚無工作流執行');
    await window.click('#w-cancel');
  } finally {
    await app.close();
  }
});

// ---- 10b. 條件沒設來源 ----

test('條件節點沒設「看誰的輸出」時，儲存要擋下來', async () => {
  const userData = userDataFor('condition-source');
  const { app, window } = await launch(userData);

  try {
    await window.click('#btn-workflow-edit');
    await window.click('#btn-add-agent');
    await dragNodeTo(window, 'agent-1', 250, 60);
    await window.click('#btn-add-condition');
    await dragNodeTo(window, 'condition-1', 470, 60);

    await wire(window, out('start'), inPort('agent-1'));
    await wire(window, out('agent-1', 'ok'), inPort('condition-1'));
    await wire(window, out('condition-1', 'yes'), inPort('end'));

    // agent 的工作目錄清空，提示也留白。
    await window.click(`${card('agent-1')} .wf-node-body`);
    await window.fill('#props-cwd', '');

    // 「看誰的輸出」維持（未選）。
    await window.click(`${card('condition-1')} .wf-node-body`);
    await expect(window.locator('#props-source')).toHaveValue('');

    await window.fill('#editor-name', '沒來源的條件');
    await window.click('#btn-editor-save');

    // 跟「角色不存在」一樣，儲存時就報錯：來源、提示、工作目錄各一條。
    await expect(window.locator('#editor-errors')).toBeVisible();
    await expect(window.locator('#editor-errors')).toContainText(
      '節點 condition-1 的條件來源不存在',
    );
    await expect(window.locator('#editor-errors')).toContainText(
      '節點 agent-1 的提示不能是空的',
    );
    await expect(window.locator('#editor-errors')).toContainText(
      '節點 agent-1 的工作目錄不能是空的',
    );
    expect(storedWorkflows(userData)).toHaveLength(0);
    await shot(window, 'condition-no-source');
  } finally {
    await app.close();
  }
});

// ---- 10c. 工作目錄不存在 ----

test('工作目錄不存在時，對話框留著並說明原因，不會開始執行', async () => {
  test.setTimeout(120_000);
  const userData = userDataFor('missing-cwd');
  const { app, window } = await launch(userData);

  try {
    await window.click('#btn-workflow-run');
    await window.fill('#w-task', '這個執行不會真的呼叫 CLI');
    // 目錄不存在 -> main 直接拒絕，不會有任何模型呼叫，所以不花錢。
    await window.fill('#w-cwd', 'D:\\myterminal-e2e-no-such-dir-97531');
    await window.click('#w-ok');

    await expect(window.locator('#workflow-run')).toBeVisible();
    await expect(window.locator('#w-errors')).toContainText(
      '工作目錄不存在：D:\\myterminal-e2e-no-such-dir-97531',
    );
    // 一個工作流都沒真的跑起來。
    await expect(window.locator('.workflow-empty')).toHaveText('尚無工作流執行');
    await shot(window, 'missing-cwd');

    await window.click('#w-cancel');
    await expect(window.locator('#workflow-run')).toBeHidden();
  } finally {
    await app.close();
  }
});

// ---- 11. 持久化 ----

test('自訂工作流在 app 重開之後還在執行對話框裡', async () => {
  test.setTimeout(120_000);
  const userData = userDataFor('persist');

  const first = await launch(userData);
  let id = '';
  try {
    await first.window.click('#btn-workflow-edit');
    await first.window.click('#btn-add-agent');
    await dragNodeTo(first.window, 'agent-1', 300, 120);
    await first.window.click(`${card('agent-1')} .wf-node-body`);
    await first.window.fill('#props-prompt', '{{params.task}}');
    await wire(first.window, out('start'), inPort('agent-1'));
    await wire(first.window, out('agent-1', 'ok'), inPort('end'));
    await first.window.fill('#editor-name', '重開還在');
    await first.window.click('#btn-editor-save');
    await expect(first.window.locator('#editor-errors')).toBeHidden();
    id = await first.window.locator('#editor-workflow').inputValue();
    expect(id).not.toBe('');
  } finally {
    await first.app.close();
  }

  const second = await launch(userData);
  try {
    await second.window.click('#btn-workflow-run');
    await expect(second.window.locator('#workflow-run')).toBeVisible();
    await expect(
      second.window.locator('#w-template optgroup[label="自訂"] option', { hasText: '重開還在' }),
    ).toHaveCount(1);
    await expect(second.window.locator(`#w-template option[value="${id}"]`)).toHaveCount(1);
    await second.window.click('#w-cancel');
  } finally {
    await second.app.close();
  }
});

// ---- 12. 八份內建範本 ----

test('內建範本都載得進畫布：節點與連線數對得上，沒有驗證錯誤，刪不掉', async () => {
  test.setTimeout(120_000);
  const userData = userDataFor('all-templates');
  const { app, window } = await launch(userData);

  try {
    await window.click('#btn-workflow-edit');
    await expect(window.locator('#workflow-editor')).toBeVisible();

    for (const template of TEMPLATES) {
      await window.selectOption('#editor-workflow', template.id);
      await expect(window.locator('#editor-name')).toHaveValue(template.name);
      await expect(window.locator('.wf-node')).toHaveCount(template.nodes.length);
      await expect(window.locator('path.wf-edge')).toHaveCount(template.edges.length);
      // 內建範本一律是合法的，而且刪不得。
      await expect(window.locator('#editor-errors')).toBeHidden();
      await expect(window.locator('#btn-editor-delete')).toBeDisabled();
    }

    await shot(window, 'all-templates');
  } finally {
    await app.close();
  }
});

test('執行對話框：內建範本八份都在，說明跟著選擇換', async () => {
  test.setTimeout(120_000);
  const userData = userDataFor('template-descriptions');
  const { app, window } = await launch(userData);

  try {
    await window.click('#btn-workflow-run');
    await expect(window.locator('#workflow-run')).toBeVisible();
    await expect(window.locator('#w-template optgroup[label="內建"] option')).toHaveCount(
      TEMPLATES.length,
    );

    for (const template of TEMPLATES) {
      await window.selectOption('#w-template', template.id);
      await expect(window.locator('#w-description')).toHaveText(template.description ?? '');
    }

    await shot(window, 'template-descriptions');
    await window.click('#w-cancel');
  } finally {
    await app.close();
  }
});
