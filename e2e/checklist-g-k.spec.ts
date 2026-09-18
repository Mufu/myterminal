import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { expectAlive, pickRole, root } from './helpers';
import type { Launched } from './checklist-helpers';
import {
  card,
  dragNodeTo,
  freshDir,
  inPort,
  launch,
  newSession,
  out,
  screenText,
  waitProbed,
  wire,
} from './checklist-helpers';

/**
 * 手動檢查表 G11、H6、H7、I5、I7、I9、I20、I21、I23、I24、K3、K4、K5、K6。
 * 不送任何提示給 CLI：G11 的工作目錄不存在 (spawn 之前就擋掉)，H6 是種一份
 * 「執行中」的 workflow-runs.json 再開 app，K6 只把 Claude 的 TUI 叫起來就關視窗。
 */

const shot = (window: Page, name: string) =>
  window.screenshot({ path: join(root, 'test-results', `${name}.png`) });

// ---- G Agent 任務 ----

test('G11 Agent 任務的工作目錄不存在：終端機顯示 ✘ 失敗：工作目錄不存在，不是 spawn ENOENT', async () => {
  const missing = win32.normalize('D:/no-such-dir-98765');
  const { app, window, dialogs } = await launch(freshDir('checklist-g11'));
  try {
    await newSession(window, 'agent', async () => {
      await window.fill('#f-agent-prompt', '只回覆 OK');
      await window.fill('#f-cwd', missing);
    });
    await expect
      .poll(() => screenText(window), { timeout: 20_000 })
      .toContain(`✘ 失敗：工作目錄不存在：${missing}`);
    const text = await screenText(window);
    expect(text).not.toContain('ENOENT');
    await expect(window.locator('.session-item')).toContainText('已結束', { timeout: 10_000 });
    await shot(window, 'g11-missing-cwd');
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

// ---- H 工作流 ----

test('H6 執行中關掉 app 再開：那筆執行變「失敗」，錯誤是「app 在執行途中關閉了」', async () => {
  const userData = freshDir('checklist-h6');
  const definition = {
    version: 1,
    id: 'wf-h6',
    name: 'H6 中斷的執行',
    nodes: [
      { id: 'start', type: 'start', label: '開始', position: { x: 40, y: 120 } },
      {
        id: 'agent-1',
        type: 'agent',
        label: '實作',
        position: { x: 240, y: 120 },
        config: { kind: 'claude', prompt: '{{params.task}}', cwd: '{{params.cwd}}' },
      },
      { id: 'end', type: 'end', label: '結束', position: { x: 440, y: 120 } },
    ],
    edges: [
      { from: 'start', to: 'agent-1' },
      { from: 'agent-1', to: 'end', port: 'ok' },
    ],
  };
  const params = { task: '做點什麼', cwd: userData };
  // workflow-service.ts 的 StoredRun：上次關 app 時 agent-1 正在跑。
  const stored = {
    definition,
    params,
    state: {
      runId: 'run-h6',
      workflowId: 'wf-h6',
      name: 'H6 中斷的執行',
      status: 'running',
      params,
      nodes: {
        start: { label: '開始', status: 'done', attempts: 0 },
        'agent-1': { label: '實作', kind: 'claude', status: 'running', attempts: 1 },
        end: { label: '結束', status: 'idle', attempts: 0 },
      },
      totalCostUsd: 0,
      startedAt: Date.now() - 60_000,
    },
  };
  writeFileSync(join(userData, 'workflow-runs.json'), JSON.stringify([stored], null, 2), 'utf8');

  const { app, window, dialogs } = await launch(userData);
  try {
    const run = window.locator('.workflow-run');
    await expect(run).toHaveCount(1);
    await expect(run.locator('.workflow-status')).toHaveText('失敗');
    await expect(run.locator('.workflow-error')).toHaveText('app 在執行途中關閉了');
    await expect(run.locator('.workflow-node[data-node="agent-1"] .session-dot')).toHaveClass(
      /failed/,
    );
    await expect(run.locator('.workflow-node[data-node="end"] .session-dot')).toHaveClass(
      /skipped/,
    );
    // 已經收尾了：沒有「取消」可以按。
    await expect(run.locator('.workflow-cancel')).toHaveCount(0);
    await shot(window, 'h6-restored');
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

test('H7 用量上限：訂閱模式留空（佔位「留空不限制」），Claude 改成 API 金鑰之後預填 2', async () => {
  test.setTimeout(150_000);
  const userData = freshDir('checklist-h7');
  const observed: string[] = [];

  const first = await launch(userData);
  try {
    const { window } = first;
    // 訂閱模式要靠真的 claude auth status (唯讀) 探出來。
    await waitProbed(window);
    const chip = (await window.locator('#cli-claude').textContent()) ?? '';
    observed.push(`開機晶片「${chip}」`);
    expect(chip, '這台機器的 Claude 應該是訂閱登入').toContain('訂閱');

    await window.click('#btn-workflow-run');
    await expect(window.locator('#workflow-run')).toBeVisible();
    await expect(window.locator('#w-budget')).toHaveValue('');
    await expect(window.locator('#w-budget')).toHaveAttribute('placeholder', '留空不限制');
    await window.click('#w-cancel');

    // F2：Claude 改成 API 金鑰 (假的，永遠不會送出去)。
    await window.click('#btn-cli-settings');
    await window.check('#cli-claude-mode-apiKey');
    await window.fill('#cli-claude-key', 'sk-ant-test-123');
    await window.click('#cli-claude-save');
    await expect(window.locator('#cli-claude-status')).toHaveText('API 金鑰');
    await window.click('#cli-close');

    await window.click('#btn-workflow-run');
    const same = await window.locator('#w-budget').inputValue();
    observed.push(`同一次開機再打開「${same}」`);
    await shot(window, 'h7-budget');
    expect.soft(same, '改成 API 金鑰之後再打開執行對話框').toBe('2');
    await window.click('#w-cancel');
  } finally {
    await first.app.close();
  }

  // 重開一次 (F2 的第三步) 再看。
  const second = await launch(userData);
  try {
    await waitProbed(second.window);
    await expect(second.window.locator('#cli-claude')).toHaveText('Claude · API 金鑰');
    await second.window.click('#btn-workflow-run');
    const restarted = await second.window.locator('#w-budget').inputValue();
    observed.push(`重開 app 之後「${restarted}」`);
    expect.soft(restarted, '重開 app 之後打開執行對話框').toBe('2');
    await second.window.click('#w-cancel');
  } finally {
    await second.app.close();
    console.log(`[H7] ${observed.join('；')}`);
  }
});

// ---- I 畫布編輯器 ----

async function openEditor(launched: Launched): Promise<void> {
  await launched.window.click('#btn-workflow-edit');
  await expect(launched.window.locator('#workflow-editor')).toBeVisible();
}

test('I5 不合法的接線：接回自己、接到開始都不接上，畫布上方短暫顯示原因', async () => {
  const launched = await launch(freshDir('checklist-i5'), { big: true });
  const { app, window } = launched;
  try {
    await openEditor(launched);
    await window.click('#btn-add-agent');
    await dragNodeTo(window, 'agent-1', 300, 120);

    // Agent 的出口拉回 Agent 自己。
    await wire(window, out('agent-1', 'ok'), `${card('agent-1')} .wf-node-label`);
    await expect(window.locator('#editor-errors')).toBeVisible();
    await expect(window.locator('#editor-errors')).toHaveText('不能接回自己');
    await expect(window.locator('path.wf-edge')).toHaveCount(0);
    await shot(window, 'i5-self');
    // 短暫：三秒後自己收掉。
    await expect(window.locator('#editor-errors')).toBeHidden({ timeout: 6_000 });

    // 出口拉到「開始」。
    await wire(window, out('agent-1', 'ok'), `${card('start')} .wf-node-label`);
    await expect(window.locator('#editor-errors')).toHaveText('開始節點不能當終點');
    await expect(window.locator('path.wf-edge')).toHaveCount(0);
    await expect(window.locator('#editor-errors')).toBeHidden({ timeout: 6_000 });
  } finally {
    await app.close();
  }
});

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

const strokeWidth = (window: Page, index: number): Promise<number> =>
  window
    .locator('path.wf-edge')
    .nth(index)
    .evaluate((el) => parseFloat(getComputedStyle(el).strokeWidth));

test('I7 刪線：點一條線 (變粗) 按 Delete，只有那條線消失', async () => {
  const launched = await launch(freshDir('checklist-i7'), { big: true });
  const { app, window } = launched;
  try {
    await openEditor(launched);
    await window.click('#btn-add-agent');
    await dragNodeTo(window, 'agent-1', 300, 120);
    await wire(window, out('start'), inPort('agent-1'));
    await wire(window, out('agent-1', 'ok'), inPort('end'));
    await expect(window.locator('path.wf-edge')).toHaveCount(2);

    const normal = await strokeWidth(window, 0);
    await selectEdge(window, 0);
    await expect(window.locator('path.wf-edge').nth(0)).toHaveClass(/selected/);
    const thick = await strokeWidth(window, 0);
    console.log(`[I7] 線寬 ${normal} → 選取後 ${thick}`);
    expect(thick).toBeGreaterThan(normal);
    await expect(window.locator('#editor-props .props-title')).toHaveText('連線：start（—）→ agent-1');
    await shot(window, 'i7-selected');

    await window.keyboard.press('Delete');
    await expect(window.locator('path.wf-edge')).toHaveCount(1);
    await expect(window.locator('.wf-node')).toHaveCount(3);
    // 留下來的是 agent-1 → end 那一條。
    await selectEdge(window, 0);
    await expect(window.locator('#editor-props .props-title')).toHaveText('連線：agent-1（成功）→ end');
  } finally {
    await app.close();
  }
});

test('I9 Agent 屬性：名稱、執行者、角色、提示、工作目錄、權限、接續對話、次數、逾時都改得動並反映在卡片上', async () => {
  const launched = await launch(freshDir('checklist-i9'), { big: true });
  const { app, window } = launched;
  const agent = card('agent-1');
  try {
    await openEditor(launched);
    await window.click('#btn-add-agent');
    await window.click('#btn-add-agent');
    await dragNodeTo(window, 'agent-2', 300, 320);
    await window.click(`${agent} .wf-node-body`);

    // 面板最上面：節點 id 與 {{id.text}} 的提示。
    await expect(window.locator('#editor-props .props-title').first()).toHaveText('Agent：agent-1');
    await expect(window.locator('#editor-props')).toContainText('{{agent-1.text}}');

    await window.fill('#props-label', 'I9 改名');
    await expect(window.locator(`${agent} .wf-node-label`)).toHaveText('I9 改名');

    for (const kind of ['codex', 'muse', 'opencode', 'claude']) {
      await window.selectOption('#props-kind', kind);
      await expect(window.locator(`${agent} .wf-kind`)).toHaveText(kind);
    }

    await pickRole(window, '#props-role-pick', '工程師', '工程師');
    await expect(window.locator(`${agent} .role-tag`)).toHaveText('工程師');
    await expect(window.locator('#props-permission')).toHaveValue('edit');

    await window.fill('#props-prompt', '{{params.task}}（I9）');
    await window.fill('#props-cwd', '{{params.cwd}}');
    for (const permission of ['readonly', 'full', 'edit']) {
      await window.selectOption('#props-permission', permission);
      await expect(window.locator('#props-permission')).toHaveValue(permission);
    }
    await window.selectOption('#props-resume-from', 'agent-2');
    await window.fill('#props-max-attempts', '3');
    await window.fill('#props-timeout', '120');
    await shot(window, 'i9-props');

    // 點別的再點回來：每一欄都還是剛才改的值。
    await window.click(`${card('agent-2')} .wf-node-body`);
    await expect(window.locator('#editor-props .props-title').first()).toHaveText('Agent：agent-2');
    await window.click(`${agent} .wf-node-body`);
    await expect(window.locator('#props-label')).toHaveValue('I9 改名');
    await expect(window.locator('#props-kind')).toHaveValue('claude');
    await expect(window.locator('#props-prompt')).toHaveValue('{{params.task}}（I9）');
    await expect(window.locator('#props-cwd')).toHaveValue('{{params.cwd}}');
    await expect(window.locator('#props-permission')).toHaveValue('edit');
    await expect(window.locator('#props-resume-from')).toHaveValue('agent-2');
    await expect(window.locator('#props-max-attempts')).toHaveValue('3');
    await expect(window.locator('#props-timeout')).toHaveValue('120');
    await expect(window.locator(`${agent} .role-tag`)).toHaveText('工程師');
  } finally {
    await app.close();
  }
});

/** 每張卡片在畫面上的左上角。*/
const cardBoxes = (window: Page) =>
  window.locator('.wf-node').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { id: (el as HTMLElement).dataset.id, x: r.x, y: r.y };
    }),
  );

test('I20 平移：在畫布空白處拖曳，整個畫布跟著動，節點之間的相對位置不變', async () => {
  const launched = await launch(freshDir('checklist-i20'), { big: true });
  const { app, window } = launched;
  try {
    await openEditor(launched);
    await window.click('#btn-add-agent');
    const before = await cardBoxes(window);
    const styleBefore = await window.locator('.wf-node').evaluateAll((els) =>
      els.map((el) => `${(el as HTMLElement).style.left},${(el as HTMLElement).style.top}`),
    );

    // 畫布左下角附近一定是空白。
    const canvas = await window.locator('#editor-canvas').boundingBox();
    if (!canvas) throw new Error('量不到畫布');
    const from = { x: canvas.x + 30, y: canvas.y + canvas.height - 40 };
    const hit = await window.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('.wf-node') === null,
      from,
    );
    expect(hit, '拖曳起點要是空白處').toBe(true);
    await window.mouse.move(from.x, from.y);
    await window.mouse.down();
    await window.mouse.move(from.x + 150, from.y - 80, { steps: 8 });
    await window.mouse.up();

    const after = await cardBoxes(window);
    for (const [i, box] of after.entries()) {
      expect(box.x - before[i].x, `${box.id} 的 x 位移`).toBeCloseTo(150, 0);
      expect(box.y - before[i].y, `${box.id} 的 y 位移`).toBeCloseTo(-80, 0);
    }
    // 平移不改節點座標 (工作流不會因此變髒)。
    const styleAfter = await window.locator('.wf-node').evaluateAll((els) =>
      els.map((el) => `${(el as HTMLElement).style.left},${(el as HTMLElement).style.top}`),
    );
    expect(styleAfter).toEqual(styleBefore);
    await shot(window, 'i20-pan');
  } finally {
    await app.close();
  }
});

test('I21 連按 ＋Agent 六次：超過一定寬度就換到下一列，不會一直往右排', async () => {
  // 預設視窗大小 (1280×800)，就是使用者一開始看到的。
  const launched = await launch(freshDir('checklist-i21'));
  const { app, window } = launched;
  try {
    await openEditor(launched);
    for (let i = 0; i < 6; i += 1) await window.click('#btn-add-agent');
    await expect(window.locator('.wf-node')).toHaveCount(8);

    const positions = await window.locator('.wf-node').evaluateAll(
      (els) =>
        els
          .filter((el) => ((el as HTMLElement).dataset.id ?? '').startsWith('agent-'))
          .map((el) => ({
            id: (el as HTMLElement).dataset.id,
            x: parseFloat((el as HTMLElement).style.left),
            y: parseFloat((el as HTMLElement).style.top),
          })),
    );
    const canvas = await window.locator('#editor-canvas').boundingBox();
    const visible = await window.locator('.wf-node').evaluateAll(
      (els, c) =>
        els.filter((el) => {
          const r = el.getBoundingClientRect();
          return c && r.right <= c.x + c.width && r.bottom <= c.y + c.height;
        }).length,
      canvas,
    );
    console.log(
      `[I21] 節點位置 ${JSON.stringify(positions)}；1280×800 下完整看得到 ${visible}/8 張卡片`,
    );
    await shot(window, 'i21-wrap');

    expect(positions).toHaveLength(6);
    // 不會一直往右：x 有上限，而且有節點排到了下一列。
    for (const p of positions) expect(p.x, p.id).toBeLessThanOrEqual(1000);
    expect(positions.some((p) => p.y > 120)).toBe(true);
    // 換列之後不會疊在一起。
    const keys = new Set(positions.map((p) => `${p.x},${p.y}`));
    expect(keys.size).toBe(6);
  } finally {
    await app.close();
  }
});

test('I23 workflows.json 裡有一筆壞掉的：app 正常啟動，壞的不出現在任何下拉，好的照常', async () => {
  const userData = freshDir('checklist-i23');
  const good = {
    version: 1,
    id: 'wf-good',
    name: '好好的流程',
    nodes: [
      { id: 'start', type: 'start', label: '開始', position: { x: 40, y: 120 } },
      {
        id: 'agent-1',
        type: 'agent',
        label: 'Agent',
        position: { x: 240, y: 120 },
        config: { kind: 'claude', prompt: '{{params.task}}', cwd: '{{params.cwd}}' },
      },
      { id: 'end', type: 'end', label: '結束', position: { x: 440, y: 120 } },
    ],
    edges: [
      { from: 'start', to: 'agent-1' },
      { from: 'agent-1', to: 'end', port: 'ok' },
    ],
  };
  // 檢查表寫的那一筆，一字不改。
  const bad = { version: 1, id: 'bad', name: 'bad', nodes: [{ id: 'x' }], edges: [] };
  writeFileSync(join(userData, 'workflows.json'), JSON.stringify([good, bad], null, 2), 'utf8');

  const launched = await launch(userData, { big: true });
  const { app, window, dialogs } = launched;
  try {
    await expectAlive(app, window);
    await openEditor(launched);
    await expect(window.locator('#editor-workflow option[value="bad"]')).toHaveCount(0);
    await expect(window.locator('#editor-workflow option[value="wf-good"]')).toHaveCount(1);
    await window.selectOption('#editor-workflow', 'wf-good');
    await expect(window.locator('.wf-node')).toHaveCount(3);
    await expect(window.locator('#editor-errors')).toBeHidden();

    await window.click('#btn-editor-close');
    await window.click('#btn-workflow-run');
    await expect(window.locator('#w-template option[value="bad"]')).toHaveCount(0);
    await expect(window.locator('#w-template option[value="wf-good"]')).toHaveCount(1);
    await window.click('#w-cancel');
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

test('I24 畫布開著時按新連接開 PowerShell：自動切回終端機看到它，再按編輯畫布還在', async () => {
  const launched = await launch(freshDir('checklist-i24'), { big: true });
  const { app, window, dialogs } = launched;
  try {
    await openEditor(launched);
    await window.click('#btn-add-agent');
    await window.fill('#editor-name', 'I24 沒存的畫布');
    await expect(window.locator('.wf-node')).toHaveCount(3);

    await newSession(window, 'powershell');
    await expect(window.locator('#workflow-editor')).toBeHidden();
    await expect(window.locator('.session-item')).toHaveCount(1);
    await expect.poll(() => screenText(window), { timeout: 30_000 }).toContain('PS ');
    await shot(window, 'i24-terminal');

    await window.click('#btn-workflow-edit');
    await expect(window.locator('#workflow-editor')).toBeVisible();
    await expect(window.locator('.wf-node')).toHaveCount(3);
    await expect(window.locator(card('agent-1'))).toHaveCount(1);
    await expect(window.locator('#editor-name')).toHaveValue('I24 沒存的畫布');
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

// ---- K 穩定性與資料 ----

test('K3 貼上 200 KB：app 本身不凍結，貼的同時按得到新連接', async () => {
  test.setTimeout(120_000);
  const { app, window, dialogs } = await launch(freshDir('checklist-k3'));
  try {
    await newSession(window, 'powershell');
    await expect.poll(() => screenText(window), { timeout: 30_000 }).toContain('PS ');
    // 2048 行、每行 100 字元的註解 ≈ 200 KB；就算真的被逐行執行也無害。
    const line = `# ${'b'.repeat(97)}\n`;
    const text = line.repeat(2048);
    await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);

    await window.click('#btn-paste');
    const clicked = Date.now();
    await window.click('#btn-new');
    await expect(window.locator('#new-connection')).toBeVisible({ timeout: 5_000 });
    const ms = Date.now() - clicked;
    console.log(`[K3] 貼上 ${text.length} 字元之後，新連接對話框 ${ms} ms 就打開了`);
    await window.click('#f-cancel');
    await expect(window.locator('#new-connection')).toBeHidden();
    await expectAlive(app, window);
    await shot(window, 'k3-paste');
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

test('K4 profiles.json 是 not json：app 正常啟動、已儲存連線為空，存一個之後檔案變回正常 JSON', async () => {
  const userData = freshDir('checklist-k4');
  const file = join(userData, 'profiles.json');
  writeFileSync(file, 'not json', 'utf8');

  const { app, window, dialogs } = await launch(userData);
  try {
    await expectAlive(app, window);
    await expect(window.locator('.profile-empty')).toHaveText('尚無儲存的連線');
    await expect(window.locator('#profile-count')).toHaveText('0');

    await newSession(window, 'powershell', async () => {
      await window.fill('#f-name', 'K4 新連線');
      await window.check('#f-save');
    });
    await expect(window.locator('#profile-list .profile-item')).toHaveCount(1);
    await expect.poll(() => readFileSync(file, 'utf8')).not.toBe('not json');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Array<{ name: string }>;
    expect(saved.map((p) => p.name)).toEqual(['K4 新連線']);
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

test('K5 userData 唯讀：儲存連線顯示失敗的錯誤，權限改回來之後又存得進去', async () => {
  test.setTimeout(120_000);
  // 只動這個測試自己的 userData，絕不碰 %APPDATA%\myterminal。
  const userData = freshDir('checklist-k5');
  const file = join(userData, 'profiles.json');
  const user = process.env.USERNAME ?? '';
  expect(user).not.toBe('');

  // 先開關一次：像使用者本來就有的那個資料夾，Electron 的東西都已經在裡面。
  const init = await launch(userData);
  await init.app.close();

  let launched: Launched | undefined;
  try {
    execFileSync('icacls', [userData, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)(RX)`]);
    // 以系統管理員身分開的 Git Bash (MSYS) 會把 SeBackupPrivilege 打開並傳給子行程，
    // libuv 開檔帶 FILE_FLAG_BACKUP_SEMANTICS，ACL 就擋不住 —— 這種環境驗不了這個案例。
    const probe = join(userData, '.k5-probe');
    let bypass = false;
    try {
      writeFileSync(probe, 'x');
      bypass = true;
    } catch {
      // 寫不進去才是我們要的唯讀。
    }
    test.skip(bypass, '這個 shell 的行程寫得穿唯讀 ACL (SeBackupPrivilege)；請從 PowerShell 跑');
    launched = await launch(userData);
    const { app, window, dialogs } = launched;
    await expectAlive(app, window);

    await newSession(window, 'powershell', async () => {
      await window.fill('#f-name', 'K5 唯讀');
      await window.check('#f-save');
    });
    await expect.poll(() => dialogs.length, { timeout: 15_000 }).toBeGreaterThan(0);
    console.log(`[K5] 唯讀時的訊息：${JSON.stringify(dialogs)}`);
    expect(dialogs[0]).toContain('儲存連線設定失敗');
    expect(existsSync(file)).toBe(false);
    await shot(window, 'k5-readonly');

    // 改回權限：同一個 app 裡再存一次就成功。
    execFileSync('icacls', [userData, '/reset', '/T']);
    await newSession(window, 'powershell', async () => {
      await window.fill('#f-name', 'K5 恢復');
      await window.check('#f-save');
    });
    await expect(window.locator('#profile-list .profile-item', { hasText: 'K5 恢復' })).toHaveCount(1);
    await expect.poll(() => existsSync(file)).toBe(true);
    expect(dialogs).toHaveLength(1);
  } finally {
    try {
      execFileSync('icacls', [userData, '/reset', '/T']);
    } catch (error) {
      console.error(`[K5] 權限還原失敗：${String(error)}`);
    }
    await launched?.app.close();
  }
});

test('K6 Claude 互動工作階段在跑的時候關視窗：15 秒內結束，沒有錯誤框', async () => {
  test.setTimeout(180_000);
  const { app, window, dialogs } = await launch(freshDir('checklist-k6'));
  await newSession(window, 'claude', async () => {
    await window.selectOption('#f-base-shell', 'powershell');
  });
  // 只等 TUI 畫出來，一個字都不打。
  await expect.poll(() => screenText(window), { timeout: 120_000 }).toMatch(/Claude Code v\d/);
  await shot(window, 'k6-claude');

  const child = app.process();
  const started = Date.now();
  const closed = app.waitForEvent('close', { timeout: 15_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  const ms = Date.now() - started;
  console.log(`[K6] 關視窗到 app 結束 ${ms} ms，離開碼 ${child.exitCode}`);
  expect(ms).toBeLessThan(15_000);
  expect(dialogs).toEqual([]);
});
