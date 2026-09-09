import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '..');

// 真的會去呼叫 claude / codex：要先登入，而且每跑一次都要付費。
test.skip(!process.env.MYTERMINAL_AGENT_E2E, '需要已登入的 claude / codex，會產生費用');

const PROMPT = '只回覆 AGENT_E2E_OK，不要做別的事';

/** 目前顯示中的那個終端機的文字 (接手之後畫面上會同時有兩個 .xterm-rows)。*/
const screenText = (window: Page): Promise<string> =>
  window
    .locator('.term-host:not([hidden]) .xterm-rows')
    .innerText()
    .catch(() => '');

/** 開一個 Agent 任務工作階段，工作目錄用一個全新的暫存目錄 (絕不動到 repo)。*/
async function startTask(window: Page, kind: 'claude' | 'codex'): Promise<void> {
  await window.click('#btn-new');
  await expect(window.locator('#new-connection')).toBeVisible();
  await window.selectOption('#f-type', 'agent');
  await window.selectOption('#f-agent-kind', kind);
  await window.fill('#f-agent-prompt', PROMPT);
  await window.fill('#f-cwd', mkdtempSync(join(tmpdir(), `myterminal-agent-${kind}-`)));
  await expect(window.locator('#f-agent-edits')).not.toBeChecked();
  await window.click('#f-ok');
}

/** 一個 CLI 一個測試：Codex 沒登入時只有它會失敗，Claude 的結論仍然有效。*/
for (const kind of ['claude', 'codex'] as const) {
  test(`${kind}：Agent 任務跑完之後可以接手`, async () => {
    // 這台開發機的 ChatGPT 帳號拿不到任何 codex 模型 (詳見 docs/AGENT-SPIKE.md)，
    // codex 那半因此預設 skip；帳號能用之後設 MYTERMINAL_AGENT_E2E_CODEX=1 就會跑。
    test.skip(
      kind === 'codex' && !process.env.MYTERMINAL_AGENT_E2E_CODEX,
      'codex 帳號目前拿不到模型 (gpt-5.5 回 404)',
    );
    // 冷啟動 + 一次真的模型呼叫，給很寬鬆的時間。
    test.setTimeout(300_000);

    const app: ElectronApplication = await electron.launch({ args: ['.'], cwd: root });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    await startTask(window, kind);

    // 任務標題會立刻出現，模型的回覆與頁尾則要等。
    await expect
      .poll(() => screenText(window), { timeout: 30_000 })
      .toContain(`[${kind}] 任務：`);
    // 標題那一行也含有標記 (它就是提示本身)，所以要求標記自己獨佔一行。
    await expect
      .poll(() => screenText(window), { timeout: 120_000 })
      .toMatch(/^AGENT_E2E_OK\s*$/m);
    await expect.poll(() => screenText(window), { timeout: 120_000 }).toContain('✔ 完成');

    const row = window.locator('.session-item').first();
    await expect(row).toContainText(kind === 'claude' ? 'Claude 任務' : 'Codex 任務');
    await expect(row.locator('.session-takeover')).toHaveCount(1);
    await row.hover();
    await window.screenshot({ path: join(root, 'test-results', 'agent.png') });

    // 接手：開出第二個工作階段，裡面是真的互動式 CLI。
    await row.locator('.session-takeover').click();
    await expect(window.locator('.session-item')).toHaveCount(2);
    await expect(window.locator('.session-item').nth(1)).toContainText('接手 ');
    await expect
      .poll(() => screenText(window), { timeout: 120_000 })
      .toMatch(kind === 'claude' ? /Claude Code|\? for shortcuts|>\s*$/m : /Codex|▌|>\s*$/m);

    await window.locator('.session-item').nth(1).locator('.session-close').click();
    await expect(window.locator('.session-item')).toHaveCount(1);

    await app.close();
  });
}
