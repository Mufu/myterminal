import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentPermission } from '../src/shared/agent';
import { freshUserData, launchApp, pickRole, root } from './helpers';

/**
 * 手動測試檢查表裡要用掉額度的那幾個案例：D3 G2 G3 G12 G13 H8 H12 M4。
 * 會真的呼叫 claude (訂閱帳號，算方案用量、不扣款)，所以預設 skip。
 *
 * 工作目錄一律是 D:/tmp/mt-auto-<案例> 這種真實長路徑：短檔名
 * (C:\Users\ROBERT~1\…) 會被 claude 當成可疑路徑要求手動核准。
 *
 * 從 Claude Code 裡面跑的話，要先把 CLAUDECODE / CLAUDE_CODE_* 這些環境變數拿掉，
 * 不然 app 裡的 claude 會以為自己是子工作階段 (例如不存對話紀錄，接手就接不回去)。
 */
test.skip(!process.env.MYTERMINAL_QUOTA_E2E, '會用掉 Claude 訂閱額度');

/** 每個案例一個全新的工作目錄。*/
function workDir(name: string): string {
  const dir = `D:/tmp/mt-auto-${name}`;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 上一輪的 CLI 可能還鎖著，留著也無妨。
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function launch(name: string): Promise<{ app: ElectronApplication; window: Page }> {
  const launched = await launchApp(freshUserData(`quota-${name}`));
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 });
  });
  return launched;
}

/** 目前顯示中的那個終端機的文字。*/
const screenText = (window: Page): Promise<string> =>
  window
    .locator('.term-host:not([hidden]) .xterm-rows')
    .innerText()
    .catch(() => '');

const shot = (window: Page, name: string) =>
  window.screenshot({ path: join(root, 'test-results', `quota-${name}.png`) });

const rows = (window: Page) => window.locator('.session-item');

/** 報告要記每一次用掉多少。*/
function logUsage(label: string, text: string): void {
  console.log(`[用量] ${label}: ${text}`);
}

/** 結果那一行 (✔ 完成 · 秒數 · ≈$金額 · session …)。*/
function footer(screen: string): string {
  return screen.match(/[✔✘] [^\n]*/g)?.at(-1) ?? '(沒有結果行)';
}

/**
 * 登入探測跑完、而且是訂閱帳號：金額的 ≈ 與 tooltip 都看這個，
 * 探測還沒回來就開始跑的話 mode 會是 unknown。
 */
async function waitSubscription(window: Page): Promise<void> {
  await expect(window.locator('#cli-claude')).toContainText('訂閱', { timeout: 60_000 });
}

interface AgentTaskSpec {
  prompt: string;
  cwd: string;
  permission?: AgentPermission;
}

async function openAgentDialog(window: Page): Promise<void> {
  await window.click('#btn-new');
  await expect(window.locator('#new-connection')).toBeVisible();
  await window.selectOption('#f-type', 'agent');
  await window.selectOption('#f-agent-kind', 'claude');
}

async function fillAndCreate(window: Page, task: AgentTaskSpec): Promise<void> {
  await window.fill('#f-agent-prompt', task.prompt);
  await window.fill('#f-cwd', task.cwd);
  if (task.permission) await window.selectOption('#f-agent-permission', task.permission);
  await window.click('#f-ok');
  await expect(window.locator('#new-connection')).toBeHidden();
}

/** 開一個 claude 的 Agent 任務，等作用中的終端機出現它的標頭。*/
async function startClaudeTask(window: Page, task: AgentTaskSpec): Promise<void> {
  await openAgentDialog(window);
  await fillAndCreate(window, task);
  await expect
    .poll(() => screenText(window), { timeout: 30_000 })
    .toContain(`[claude] 任務：${task.prompt}`);
}

/** 等作用中那個 agent 任務跑完 (成功或失敗)，回傳整個畫面。*/
async function waitFinished(window: Page, timeout = 300_000): Promise<string> {
  await expect.poll(() => screenText(window), { timeout }).toMatch(/✔ 完成|✘ 失敗/);
  return screenText(window);
}

/** 目前所有 claude.exe 的命令列。*/
function claudeCommandLines(): string[] {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ForEach-Object { $_.CommandLine }`,
    ],
    { encoding: 'utf8' },
  );
  return out.split(/\r?\n/).filter((line) => line.trim() !== '');
}

// ---------------------------------------------------------------- D3

test('D3：輸入字的兩行進到 Claude 成為同一段提示，只回一次 OK', async () => {
  test.setTimeout(300_000);
  const cwd = workDir('d3');
  const { app, window } = await launch('d3');

  try {
    await window.click('#btn-new');
    await expect(window.locator('#new-connection')).toBeVisible();
    await window.selectOption('#f-type', 'claude');
    await window.fill('#f-cwd', cwd);
    await window.click('#f-ok');

    // 歡迎畫面：輸入框的提示字與模式列。沒信任過的資料夾會先問一次，預設就是「是」。
    const ready = /shift\+tab to cycle|for shortcuts|❯ Try/;
    await expect
      .poll(() => screenText(window), { timeout: 120_000 })
      .toMatch(new RegExp(`${ready.source}|trust`, 'i'));
    if (!ready.test(await screenText(window))) {
      await window.locator('.term-host:not([hidden]) .xterm-helper-textarea').focus();
      await window.keyboard.press('Enter');
    }
    await expect.poll(() => screenText(window), { timeout: 120_000 }).toMatch(ready);
    await shot(window, 'd3-ready');

    await window.click('#btn-input');
    await expect(window.locator('#input-panel')).toBeVisible();
    await window.fill('#input-text', '只回覆 OK。\n不要做別的事。');
    await window.locator('#input-text').press('Control+Enter');

    // 回答是「● OK」(其他平台是 ⏺)。
    await expect.poll(() => screenText(window), { timeout: 180_000 }).toMatch(/[●⏺]\s*OK\b/);
    // 多等一下：兩行被拆成兩次送出的話，第二個回答會跟著進來。
    await window.waitForTimeout(10_000);
    const screen = await screenText(window);
    console.log(`\n=== D3 畫面 ===\n${screen}\n`);
    await shot(window, 'd3-answer');

    // 兩行在同一段提示裡 (中間只有換行與縮排)，只有一個回答，輸入框沒有殘留第二行。
    expect(screen).toMatch(/只回覆 OK。\s*\n\s*不要做別的事。/);
    expect(screen.match(/[●⏺]\s*OK\b/g)).toHaveLength(1);
    expect(screen).not.toMatch(/^[❯>]\s*不要做別的事。/m);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- G2 + G12 (結果行)

test('G2 / G12：可修改檔案建得出 hello.txt，唯讀建不出 blocked.txt；結果行是 ≈$', async () => {
  test.setTimeout(600_000);
  const editDir = workDir('g2-edit');
  const readonlyDir = workDir('g2-readonly');
  const { app, window } = await launch('g2');

  try {
    await waitSubscription(window);

    await openAgentDialog(window);
    await expect(window.locator('#f-agent-permission option')).toHaveText([
      '唯讀',
      '可修改檔案',
      '完全放行（會執行任何指令）',
    ]);
    await fillAndCreate(window, {
      prompt: '在工作目錄建立 hello.txt 內容 hi',
      cwd: editDir,
      permission: 'edit',
    });
    const first = await waitFinished(window);
    await shot(window, 'g2-edit');
    logUsage('G2 可修改檔案', footer(first));

    expect(first).toContain('✔ 完成');
    expect(existsSync(join(editDir, 'hello.txt'))).toBe(true);
    // G12：訂閱帳號的金額前面有 ≈。
    expect(first).toMatch(/✔ 完成 · [\d.]+ s · ≈\$\d+\.\d{3}/);
    await expect(rows(window).first()).toContainText('Claude 任務');

    await startClaudeTask(window, {
      prompt: '在工作目錄建立 blocked.txt',
      cwd: readonlyDir,
      permission: 'readonly',
    });
    const second = await waitFinished(window);
    await shot(window, 'g2-readonly');
    logUsage('G2 唯讀', footer(second));
    console.log(`\n=== G2 唯讀的畫面 ===\n${second}\n`);

    expect(existsSync(join(readonlyDir, 'blocked.txt'))).toBe(false);
    // Claude 說明它在唯讀 / plan 模式；措辭不固定，所以是軟斷言。
    expect.soft(second).toMatch(/plan|唯讀|規劃|計畫|計劃|權限|無法|不能/i);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- G3

test('G3：選審查者權限跳成唯讀，清單上有角色標籤，回答以審查者身分', async () => {
  test.setTimeout(420_000);
  const cwd = workDir('g3');
  const { app, window } = await launch('g3');

  try {
    await waitSubscription(window);
    await openAgentDialog(window);
    // 先故意改成可修改檔案，選了審查者要自己跳回唯讀。
    await window.selectOption('#f-agent-permission', 'edit');
    await pickRole(window, '#f-agent-role-pick', '審查', '審查者');
    await expect(window.locator('#f-agent-role-name')).toContainText('審查者');
    await expect(window.locator('#f-agent-permission')).toHaveValue('readonly');
    // 換成工程師變可修改檔案，再換回審查者又是唯讀。
    await pickRole(window, '#f-agent-role-pick', '工程師', '工程師');
    await expect(window.locator('#f-agent-role-name')).not.toContainText('測試');
    await expect(window.locator('#f-agent-permission')).toHaveValue('edit');
    await pickRole(window, '#f-agent-role-pick', '審查', '審查者');
    await expect(window.locator('#f-agent-permission')).toHaveValue('readonly');

    await fillAndCreate(window, { prompt: '用一句話說明你現在扮演的角色', cwd });
    await expect(rows(window).first().locator('.role-tag')).toContainText('審查者');

    const screen = await waitFinished(window);
    await shot(window, 'g3');
    logUsage('G3 審查者', footer(screen));
    console.log(`\n=== G3 畫面 ===\n${screen}\n`);
    expect(screen).toContain('✔ 完成');
    // 標頭那一行就是提示本身，裡面沒有「審查」兩個字，所以出現了就是回答講的。
    expect(screen).toMatch(/審查/);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- G13

const GIT_PROMPT = '用 Bash 執行 git --version 並回覆輸出';

test('G13：完全放行跑得了 git --version，可修改檔案被擋；接手帶跳過權限的旗標', async () => {
  test.setTimeout(720_000);
  const fullDir = workDir('g13-full');
  const editDir = workDir('g13-edit');
  const { app, window } = await launch('g13');

  try {
    await waitSubscription(window);

    // 第一次：完全放行
    await openAgentDialog(window);
    await fillAndCreate(window, { prompt: GIT_PROMPT, cwd: fullDir, permission: 'full' });
    await expect
      .poll(() => screenText(window), { timeout: 30_000 })
      .toContain(`[claude] 任務：${GIT_PROMPT} [完全放行]`);
    const full = await waitFinished(window);
    await shot(window, 'g13-full');
    logUsage('G13 完全放行', footer(full));
    console.log(`\n=== G13 完全放行 ===\n${full}\n`);
    expect(full).toContain('✔ 完成');
    expect(full).toMatch(/git version \d+\.\d+/);
    await expect(rows(window).nth(0).locator('.perm-tag')).toHaveText('完全放行');
    const prefix = full.match(/session ([0-9a-f]{8})…/)?.[1] ?? '';
    expect(prefix).not.toBe('');

    // 第二次：可修改檔案 (acceptEdits 會擋 Bash)
    await startClaudeTask(window, { prompt: GIT_PROMPT, cwd: editDir, permission: 'edit' });
    const edit = await waitFinished(window);
    await shot(window, 'g13-edit');
    logUsage('G13 可修改檔案', footer(edit));
    console.log(`\n=== G13 可修改檔案 ===\n${edit}\n`);
    expect(edit).not.toContain('[完全放行]');
    expect(edit).not.toMatch(/git version \d+\.\d+/);
    expect.soft(edit).toMatch(/權限|核准|批准|拒絕|擋|允許|同意|permission|denied|approv/i);
    await expect(rows(window).nth(1).locator('.perm-tag')).toHaveCount(0);

    // 接手第一次那一列：啟動指令要帶 --dangerously-skip-permissions。
    const fullRow = rows(window).nth(0);
    await fullRow.hover();
    await fullRow.locator('.session-takeover').click();
    await expect(rows(window)).toHaveCount(3);
    await expect(rows(window).nth(2)).toContainText('接手 ');
    const startup = new RegExp(
      `claude --resume ${prefix}[0-9a-f-]{28} --dangerously-skip-permissions`,
    );
    // 啟動指令是打進 PowerShell 的那一行；claude 起來之後可能被對話紀錄推出畫面，所以輪詢得勤一點。
    await expect
      .poll(() => screenText(window), { timeout: 60_000, intervals: [100] })
      .toMatch(startup);
    console.log(`[G13] 接手的啟動指令：${(await screenText(window)).match(startup)?.[0]}`);
    await shot(window, 'g13-takeover');

    // 不在接手的 claude 裡打任何字，直接關掉；那支 claude 也要跟著收掉。
    await rows(window).nth(2).locator('.session-close').click();
    await expect(rows(window)).toHaveCount(2);
    await expect
      .poll(() => claudeCommandLines().filter((line) => line.includes(`--resume ${prefix}`)), {
        timeout: 30_000,
      })
      .toEqual([]);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- 工作流共用

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** 三個檔案的小 git repo，給「程式碼審查（唯讀）」看。*/
function smallRepo(name: string): string {
  const dir = workDir(name);
  writeFileSync(join(dir, 'README.md'), '# demo\n\n讀設定檔然後印出 port。\n', 'utf8');
  writeFileSync(
    join(dir, 'app.js'),
    [
      "const fs = require('fs');",
      "const { parsePort } = require('./util');",
      '',
      'function main() {',
      "  const raw = fs.readFileSync('config.json', 'utf8');",
      '  const config = JSON.parse(raw);',
      '  console.log(parsePort(config.port));',
      '}',
      '',
      'main();',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(dir, 'util.js'),
    [
      'function parsePort(value) {',
      '  return parseInt(value);',
      '}',
      '',
      'module.exports = { parsePort };',
      '',
    ].join('\n'),
    'utf8',
  );
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'init');
  return dir;
}

const run = (window: Page) => window.locator('.workflow-run').first();
const status = (window: Page) => run(window).locator('.workflow-status');
const node = (window: Page, id: string) => run(window).locator(`.workflow-node[data-node="${id}"]`);

async function startTemplate(
  window: Page,
  template: string,
  task: string,
  cwd: string,
  budget = '',
): Promise<void> {
  await window.click('#btn-workflow-run');
  await expect(window.locator('#workflow-run')).toBeVisible();
  await window.selectOption('#w-template', template);
  await window.fill('#w-task', task);
  await window.fill('#w-cwd', cwd);
  await window.fill('#w-budget', budget);
  await window.click('#w-ok');
  await expect(window.locator('#workflow-run')).toBeHidden();
}

const runUsage = (window: Page): Promise<string> =>
  run(window)
    .locator('.workflow-cost')
    .innerText()
    .catch(() => '(沒有金額)');

// ---------------------------------------------------------------- H12 + G12 (tooltip)

const SUBSCRIPTION_TITLE =
  'CLI 依 token 用量估算的 API 等值金額，訂閱帳號不另收費，只算進方案的用量上限';

test('H12 / G12：程式碼審查（唯讀）不停下來問就完成，最後一行 PASS/FAIL，git status 不變', async () => {
  test.setTimeout(600_000);
  const repo = smallRepo('h12');
  const before = git(repo, 'status', '--porcelain');
  const { app, window } = await launch('h12');

  try {
    await waitSubscription(window);
    await startTemplate(window, 'code-review', 'app.js 與 util.js 的錯誤處理', repo);
    await expect(status(window)).toHaveText('執行中', { timeout: 30_000 });

    // 開始 → 審查 → 結束：只有一個 agent 節點，工作階段名稱是「範本名 · 節點名」。
    await expect(run(window).locator('.workflow-node')).toHaveCount(3);
    await expect(rows(window).first()).toContainText('程式碼審查（唯讀） · 審查', {
      timeout: 60_000,
    });

    await expect(status(window)).toHaveText('完成', { timeout: 540_000 });
    await expect(run(window).locator('.workflow-approve')).toHaveCount(0);
    await expect(node(window, 'end').locator('.session-dot')).toHaveClass(/done/);

    // G12：清單上的金額是 ≈$，tooltip 說清楚是估算、訂閱不另收費。
    const cost = run(window).locator('.workflow-cost');
    await expect(cost).toHaveText(/^≈\$\d+\.\d{3}$/);
    await expect(cost).toHaveAttribute('title', SUBSCRIPTION_TITLE);
    logUsage('H12 程式碼審查', await runUsage(window));

    await node(window, 'reviewer').click();
    await expect.poll(() => screenText(window), { timeout: 20_000 }).toContain('✔ 完成');
    const screen = await screenText(window);
    await shot(window, 'h12');
    console.log(`\n=== H12 審查的終端機 ===\n${screen}\n`);
    // 結果行前面那一行只有 PASS 或 FAIL。
    expect(screen).toMatch(/^\s*(PASS|FAIL)\s*\n(\s*\n)*[^\n]*✔ 完成/m);

    expect(git(repo, 'status', '--porcelain')).toBe(before);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- H8

test('H8：用量上限 0.01 → 第一個節點跑完就失敗', async () => {
  test.setTimeout(480_000);
  const repo = smallRepo('h8');
  const { app, window } = await launch('h8');

  try {
    await waitSubscription(window);
    await startTemplate(window, 'code-review', '只看 README.md，一句話就好', repo, '0.01');
    await expect(status(window)).toHaveText('失敗', { timeout: 420_000 });
    await expect(run(window).locator('.workflow-error')).toContainText(
      '超出這次執行的用量上限 (估算 $0.01)',
    );
    await expect(node(window, 'reviewer').locator('.session-dot')).toHaveClass(/failed/);
    await shot(window, 'h8');
    logUsage('H8 用量上限', await runUsage(window));
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- M4

const PALETTE = ['Agent', '條件', '批准', '結束'];

test('M4：在畫布上問「怎麼加節點」，答案講的是調色盤，不是新連接', async () => {
  test.setTimeout(300_000);
  const { app, window } = await launch('m4');

  try {
    await window.click('#btn-workflow-edit');
    await expect(window.locator('#workflow-editor')).toBeVisible();
    const nodesBefore = await window.locator('.wf-node').count();

    await window.click('#btn-assistant');
    await expect(window.locator('#assistant-panel')).toBeVisible();
    await window.fill('#assistant-input', '我現在這個畫面怎麼加節點？');
    await window.click('#assistant-send');
    await expect(window.locator('#assistant-status')).toHaveText('回答中…');

    await expect(window.locator('#assistant-input')).toBeEnabled({ timeout: 240_000 });
    await expect(window.locator('#assistant-status')).toContainText('$', { timeout: 10_000 });
    const answer = await window.locator('.assistant-msg.bot').first().innerText();
    const usage = await window.locator('#assistant-status').innerText();
    logUsage('M4 助理', usage);
    console.log(`\n=== M4 答案 (${usage}) ===\n${answer}\n=== M4 答案結束 ===\n`);
    writeFileSync(join(root, 'test-results', 'quota-m4-answer.txt'), answer, 'utf8');
    await shot(window, 'm4');

    const hits = PALETTE.filter((key) => answer.includes(key));
    expect(hits.length, `答案提到的按鈕：${hits.join('、')}`).toBeGreaterThanOrEqual(2);
    expect.soft(answer).not.toContain('新連接');
    // 助理只回答：畫布上的節點一個都沒多也沒少，也還在畫布上。
    await expect(window.locator('.wf-node')).toHaveCount(nodesBefore);
    await expect(window.locator('#workflow-editor')).toBeVisible();
  } finally {
    await app.close();
  }
});
