import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './helpers';
import type { Launched } from './checklist-helpers';
import {
  card,
  dragNodeTo,
  envWith,
  freshDir,
  inPort,
  launch,
  newSession,
  out,
  screenText,
  wire,
} from './checklist-helpers';

/**
 * 手動檢查表 G8、J5、J6：真的跑一次 OpenCode，但只用免費模型
 * (opencode/mimo-v2.5-free，只要網路、不要金鑰)。claude / codex / muse 一個都不叫。
 */
test.skip(
  !process.env.MYTERMINAL_AGENT_E2E_OPENCODE,
  '需要網路，用 OpenCode 免費模型，不需金鑰',
);

const FREE = { MYTERMINAL_OPENCODE_MODEL: 'opencode/mimo-v2.5-free' };

const shot = (window: Page, name: string) =>
  window.screenshot({ path: join(root, 'test-results', `${name}.png`) });

/** agent 真的會在這裡工作，所以是全新的目錄，而且展開成長路徑 (不要 8.3 短檔名)。*/
const workDir = (name: string): string => realpathSync.native(freshDir(name));

test('G8 接手 OpenCode 的 Agent 任務：開出 opencode --session <id> 的 TUI', async () => {
  test.setTimeout(300_000);
  const work = workDir('checklist-g8-work');
  const { app, window, dialogs } = await launch(freshDir('checklist-g8'), { env: envWith(FREE) });
  try {
    // 接手的那一行一送進去，TUI 就切到替代畫面把它蓋掉，所以直接收 pty 的原始輸出。
    // 先等頁面真的載完：firstWindow 可能還在從 about:blank 換到 index.html。
    await expect(window.locator('#btn-new')).toBeVisible();
    await window.waitForLoadState('load');
    await window.evaluate(() => {
      const g = globalThis as unknown as {
        __pty: string;
        myterminal: { onData(cb: (e: { id: string; data: string }) => void): void };
      };
      g.__pty = '';
      g.myterminal.onData((e) => {
        g.__pty += e.data;
      });
    });

    await newSession(window, 'agent', async () => {
      await window.selectOption('#f-agent-kind', 'opencode');
      await window.fill('#f-agent-prompt', 'Reply with exactly OPENCODE_OK');
      await window.fill('#f-cwd', work);
    });
    await expect.poll(() => screenText(window), { timeout: 30_000 }).toContain('[opencode] 任務：');
    await expect.poll(() => screenText(window), { timeout: 180_000 }).toMatch(/^OPENCODE_OK\s*$/m);
    await expect.poll(() => screenText(window), { timeout: 60_000 }).toContain('✔ 完成');

    const sessionId = await window.evaluate(async () => {
      const g = globalThis as unknown as {
        myterminal: { list(): Promise<Array<{ agentSessionId?: string }>> };
      };
      return (await g.myterminal.list())[0]?.agentSessionId ?? '';
    });
    expect(sessionId).not.toBe('');

    const row = window.locator('.session-item').first();
    await expect(row).toContainText('OpenCode 任務');
    await row.hover();
    await row.locator('.session-takeover').click();
    await expect(window.locator('.session-item')).toHaveCount(2);
    await expect(window.locator('.session-item').nth(1)).toContainText('接手 ');

    const raw = () =>
      window.evaluate(() => (globalThis as unknown as { __pty: string }).__pty.replace(/\s+/g, ' '));
    await expect.poll(raw, { timeout: 60_000 }).toContain(`opencode --session ${sessionId}`);

    // TUI 起來之後看得到剛才那段對話 (OPENCODE_OK 是模型回的那一句)。
    await expect.poll(() => screenText(window), { timeout: 90_000 }).toContain('OPENCODE_OK');
    await shot(window, 'g8-takeover');

    // 一個字都不打，直接關掉接手的那個工作階段。
    await window.locator('.session-item').nth(1).locator('.session-close').click();
    await expect(window.locator('.session-item')).toHaveCount(1);
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

/** 在畫布上拉出 開始 → agent (OpenCode) [→ 批准] → 結束，然後「儲存並執行」。*/
async function buildAndRun(
  launched: Launched,
  opts: { name: string; prompt: string; approval: boolean; cwd: string },
): Promise<void> {
  const { window } = launched;
  await window.click('#btn-workflow-edit');
  await expect(window.locator('#workflow-editor')).toBeVisible();
  await window.click('#btn-add-agent');
  await dragNodeTo(window, 'agent-1', 260, 60);
  if (opts.approval) {
    await window.click('#btn-add-approval');
    await dragNodeTo(window, 'approval-1', 500, 60);
  }
  await dragNodeTo(window, 'end', opts.approval ? 740 : 500, 60);

  await window.click(`${card('agent-1')} .wf-node-body`);
  await window.selectOption('#props-kind', 'opencode');
  await window.fill('#props-prompt', opts.prompt);
  await window.fill('#props-cwd', '{{params.cwd}}');

  await wire(window, out('start'), inPort('agent-1'));
  if (opts.approval) {
    await window.click(`${card('approval-1')} .wf-node-body`);
    await window.fill('#props-question', '要收下這次的結果嗎？');
    await wire(window, out('agent-1', 'ok'), inPort('approval-1'));
    await wire(window, out('approval-1', 'approved'), inPort('end'));
    await expect(window.locator('path.wf-edge')).toHaveCount(3);
  } else {
    await wire(window, out('agent-1', 'ok'), inPort('end'));
    await expect(window.locator('path.wf-edge')).toHaveCount(2);
  }
  await window.fill('#editor-name', opts.name);

  await window.click('#btn-editor-run');
  await expect(window.locator('#workflow-run')).toBeVisible();
  await window.fill('#w-task', '檢查表自動化');
  await window.fill('#w-cwd', opts.cwd);
  await window.click('#w-ok');
  await expect(window.locator('#workflow-run')).toBeHidden();
  // 開始之後留在畫布上。
  await expect(window.locator('#workflow-editor')).toBeVisible();
}

test('J5 畫布上執行到批准，卡片上按「退回」：執行變「已退回」', async () => {
  test.setTimeout(300_000);
  const launched = await launch(freshDir('checklist-j5'), { env: envWith(FREE), big: true });
  const { app, window, dialogs } = launched;
  try {
    await buildAndRun(launched, {
      name: 'J5 退回',
      prompt: 'Reply with exactly J5_OK',
      approval: true,
      cwd: workDir('checklist-j5-work'),
    });

    const approval = window.locator(`${card('approval-1')} .wf-run-label`);
    await expect(approval).toHaveText('等待批准', { timeout: 240_000 });
    await expect(window.locator(`${card('agent-1')} .wf-run-label`)).toHaveText('完成');
    await window.click(`${card('approval-1')} .wf-reject`);

    const status = window.locator('#editor-run .workflow-status');
    await expect(status).toHaveText('已退回', { timeout: 60_000 });
    await expect(status).toHaveClass(/rejected/);
    // 退回是人的決定，不是錯誤：沒有錯誤文字。
    await expect(window.locator('#editor-run .workflow-error')).toHaveCount(0);
    await expect(window.locator(`${card('end')} .wf-run-label`)).toHaveText('略過');
    await expect(window.locator('.workflow-run').first().locator('.workflow-status')).toHaveText(
      '已退回',
    );
    await shot(window, 'j5-rejected');
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

test('J6 Agent 執行中從編輯列按「取消」→ 確認：執行變「已取消」，卡片狀態是中性色', async () => {
  test.setTimeout(300_000);
  const launched = await launch(freshDir('checklist-j6'), { env: envWith(FREE), big: true });
  const { app, window, dialogs } = launched;
  try {
    await buildAndRun(launched, {
      name: 'J6 取消',
      prompt: '列出 1 到 300 的每個數字，一行一個',
      approval: false,
      cwd: workDir('checklist-j6-work'),
    });

    const agent = card('agent-1');
    await expect(window.locator(`${agent} .wf-run-label`)).toHaveText('執行中', { timeout: 60_000 });
    await window.click('#editor-run .wf-run-cancel');

    const status = window.locator('#editor-run .workflow-status');
    await expect(status).toHaveText('已取消', { timeout: 15_000 });
    await expect(window.locator(agent)).toHaveAttribute('data-run-status', 'cancelled');
    await expect(window.locator(`${agent} .wf-run-label`)).toHaveText('已取消');
    await expect(window.locator(`${agent} .wf-run .session-dot`)).toHaveClass(/cancelled/);
    await expect(window.locator(`${agent} .wf-run .session-dot`)).not.toHaveClass(/failed/);
    await expect(window.locator(`${card('end')} .wf-run-label`)).toHaveText('略過');

    // 中性色：跟「失敗」那個紅點不是同一個顏色。
    const colors = await window.locator(`${agent} .wf-run .session-dot`).evaluate((dot) => {
      const probe = document.createElement('span');
      probe.className = 'session-dot failed';
      dot.parentElement?.appendChild(probe);
      const failed = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { cancelled: getComputedStyle(dot).backgroundColor, failed };
    });
    console.log(`[J6] 已取消的點 ${colors.cancelled}，失敗的點 ${colors.failed}`);
    expect(colors.cancelled).not.toBe(colors.failed);

    // 取消前問過一次。
    expect(dialogs).toHaveLength(1);
    await shot(window, 'j6-cancelled');
  } finally {
    await app.close();
  }
});
