import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pickRole } from './helpers';

const root = join(__dirname, '..');

/**
 * 自訂工作流的真實執行：條件、批准／退回、逾時、取消、codex 節點與角色。
 * 會真的呼叫 claude / codex (訂閱帳號，算方案用量)，所以預設 skip。
 */
test.skip(!process.env.MYTERMINAL_WORKFLOW_E2E, '需要已登入的 claude / codex，會用掉訂閱額度');

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

const pos = (x: number, y: number): { x: number; y: number } => ({ x, y });

/** start → agent → end 這種一直線的工作流，差別只在 agent 的設定。*/
function straight(id: string, name: string, config: Record<string, unknown>): Definition {
  return {
    version: 1,
    id,
    name,
    nodes: [
      { id: 'start', type: 'start', label: '開始', position: pos(40, 120) },
      { id: 'agent-1', type: 'agent', label: '執行', position: pos(240, 120), config },
      { id: 'end', type: 'end', label: '結束', position: pos(440, 120) },
    ],
    edges: [
      { from: 'start', to: 'agent-1' },
      { from: 'agent-1', to: 'end', port: 'ok' },
    ],
  };
}

/** A：實作 → 條件 → 批准 → 結束，條件不成立就直接結束。*/
const APPROVAL: Definition = {
  version: 1,
  id: 'wf-e2e-approval',
  name: 'E2E 批准與退回',
  nodes: [
    { id: 'start', type: 'start', label: '開始', position: pos(40, 120) },
    {
      id: 'agent-1',
      type: 'agent',
      label: '實作',
      position: pos(240, 120),
      config: {
        kind: 'claude',
        role: 'coder',
        permission: 'edit',
        cwd: '{{params.cwd}}',
        prompt:
          '在工作目錄建立 hello.txt，內容 hi，最後一行只輸出 DONE（DONE 之後不要再寫任何字）',
      },
    },
    {
      id: 'condition-1',
      type: 'condition',
      label: '檢查',
      position: pos(440, 120),
      config: { source: 'agent-1', rule: { type: 'lastLineEquals', value: 'DONE' } },
    },
    {
      id: 'approval-1',
      type: 'approval',
      label: '批准',
      position: pos(640, 120),
      config: { question: '要保留這次的變更嗎？' },
    },
    { id: 'end', type: 'end', label: '結束', position: pos(840, 120) },
  ],
  edges: [
    { from: 'start', to: 'agent-1' },
    { from: 'agent-1', to: 'condition-1', port: 'ok' },
    { from: 'condition-1', to: 'approval-1', port: 'yes' },
    { from: 'condition-1', to: 'end', port: 'no' },
    { from: 'approval-1', to: 'end', port: 'approved' },
  ],
};

const LONG_PROMPT = '列出工作目錄下所有檔案並逐一說明用途，至少寫 400 字';

/** B：五秒就逾時的節點。*/
const TIMEOUT = straight('wf-e2e-timeout', 'E2E 逾時', {
  kind: 'claude',
  permission: 'readonly',
  cwd: '{{params.cwd}}',
  prompt: LONG_PROMPT,
  timeoutSec: 5,
});

/** C：跑得夠久，來得及按取消。*/
const CANCEL = straight('wf-e2e-cancel', 'E2E 取消', {
  kind: 'claude',
  permission: 'readonly',
  cwd: '{{params.cwd}}',
  prompt: LONG_PROMPT,
});

/** D：codex 節點。*/
const CODEX = straight('wf-e2e-codex', 'E2E Codex', {
  kind: 'codex',
  permission: 'readonly',
  cwd: '{{params.cwd}}',
  prompt: 'Reply with exactly CODEX_WF_OK',
});

/** E：角色有沒有真的送到 CLI。*/
const ROLE = straight('wf-e2e-role', 'E2E 角色', {
  kind: 'claude',
  role: 'reviewer',
  permission: 'readonly',
  cwd: '{{params.cwd}}',
  prompt: '用一句話說明你現在扮演的角色',
});

const ALL: Definition[] = [APPROVAL, TIMEOUT, CANCEL, CODEX, ROLE];

/**
 * 工作目錄一定要是長路徑：短檔名 (C:\Users\ROBERT~1\…) 會被 claude 當成
 * 可疑路徑要求手動核准，在 -p 非互動模式下核准不了。放在 repo 的
 * test-results 下面就一定是長路徑。
 */
function workDir(name: string): string {
  const dir = resolve(root, 'test-results', `wf-work-${name}`);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 上一次的 Electron 可能還鎖著，留著也無妨。
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 每個案例一份乾淨的 userData，並先把工作流定義放進去。*/
function seededUserData(name: string): string {
  const dir = resolve(root, 'test-results', `wf-user-${name}`);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 同上。
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workflows.json'), JSON.stringify(ALL, null, 2), 'utf8');
  return dir;
}

async function launch(userData: string): Promise<Launched> {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 });
  });
  return { app, window };
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

/** 這次執行用掉的額度 (訂閱帳號是估算值)，報告要記。*/
async function reportUsage(window: Page, label: string): Promise<void> {
  const cost = await run(window)
    .locator('.workflow-cost')
    .innerText()
    .catch(() => '(沒有金額)');
  const error = await run(window)
    .locator('.workflow-error')
    .innerText()
    .catch(() => '');
  console.log(`[用量] ${label}: ${cost}${error ? ` · 錯誤訊息「${error}」` : ''}`);
}

async function startRun(window: Page, id: string, task: string, cwd: string): Promise<void> {
  await window.click('#btn-workflow-run');
  await expect(window.locator('#workflow-run')).toBeVisible();
  await window.selectOption('#w-template', id);
  await window.fill('#w-task', task);
  await window.fill('#w-cwd', cwd);
  await window.click('#w-ok');
  await expect(window.locator('#workflow-run')).not.toBeVisible();
}

/** app 主行程底下還活著的 claude.exe。逾時之後應該一個都不剩。*/
function claudeChildren(parentPid: number): number[] {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.ParentProcessId -eq ${parentPid} } | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: 'utf8' },
  );
  return out
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

// ---- A. 條件 + 批准 + 退回 ----

test('A：條件成立後停在批准，按退回收尾而檔案留著', async () => {
  test.setTimeout(600_000);
  const work = workDir('approval');
  const { app, window } = await launch(seededUserData('approval'));

  try {
    await startRun(window, APPROVAL.id, '建立 hello.txt', work);
    await expect(status(window)).toHaveText('執行中', { timeout: 30_000 });

    await expect(status(window)).toHaveText('等待批准', { timeout: 300_000 });
    await expect(run(window).locator('.workflow-question')).toHaveText('要保留這次的變更嗎？');
    await expect(node(window, 'agent-1').locator('.session-dot')).toHaveClass(/done/);
    await expect(node(window, 'condition-1').locator('.session-dot')).toHaveClass(/done/);
    await expect(node(window, 'approval-1').locator('.session-dot')).toHaveClass(/waiting/);
    // 工程師的角色標籤跟著節點一起顯示。
    await expect(node(window, 'agent-1').locator('.role-tag')).toHaveText('工程師');

    await window.screenshot({ path: join(root, 'test-results', 'wf-a-waiting.png') });

    await run(window).locator('.workflow-reject').click();
    await expect(status(window)).toHaveText('已退回', { timeout: 60_000 });
    // 退回是人做的決定，不是壞掉，所以沒有錯誤訊息。
    await expect(run(window).locator('.workflow-error')).toHaveCount(0);
    // 沒有走到結束節點。
    await expect(node(window, 'end').locator('.session-dot')).toHaveClass(/skipped/);

    expect(existsSync(join(work, 'hello.txt'))).toBe(true);

    await window.screenshot({ path: join(root, 'test-results', 'wf-a-rejected.png') });
    await reportUsage(window, 'A 批准/退回');
  } finally {
    await app.close();
  }
});

// ---- B. 逾時 ----

test('B：節點逾時就失敗，而且 CLI 行程被砍掉', async () => {
  test.setTimeout(180_000);
  const work = workDir('timeout');
  const { app, window } = await launch(seededUserData('timeout'));
  const mainPid = await app.evaluate(() => process.pid);

  try {
    const started = Date.now();
    await startRun(window, TIMEOUT.id, LONG_PROMPT, work);

    await expect(status(window)).toHaveText('失敗', { timeout: 60_000 });
    const elapsed = Date.now() - started;
    await expect(run(window).locator('.workflow-error')).toContainText('超過 5 秒');
    expect(elapsed).toBeLessThan(30_000);
    console.log(`[逾時] 從按下開始到失敗：${(elapsed / 1000).toFixed(1)} s`);

    await expect(node(window, 'agent-1').locator('.session-dot')).toHaveClass(/failed/);
    // 砍掉的 CLI 不能留在背景繼續跑。
    await expect.poll(() => claudeChildren(mainPid).length, { timeout: 30_000 }).toBe(0);

    await window.screenshot({ path: join(root, 'test-results', 'wf-b-timeout.png') });
    await reportUsage(window, 'B 逾時');
  } finally {
    await app.close();
  }
});

// ---- C. 取消 ----

test('C：執行中按取消，十秒內變成已取消', async () => {
  test.setTimeout(300_000);
  const work = workDir('cancel');
  const { app, window } = await launch(seededUserData('cancel'));
  window.on('dialog', (dialog) => void dialog.accept());

  try {
    await startRun(window, CANCEL.id, LONG_PROMPT, work);
    await expect(status(window)).toHaveText('執行中', { timeout: 30_000 });
    // 等 CLI 真的起來 (節點拿到工作階段) 再取消。
    await expect(node(window, 'agent-1').locator('.session-dot')).toHaveClass(/running/, {
      timeout: 60_000,
    });

    await run(window).locator('.workflow-cancel').click();
    await expect(status(window)).toHaveText('已取消', { timeout: 10_000 });

    await window.screenshot({ path: join(root, 'test-results', 'wf-c-cancelled.png') });
    await reportUsage(window, 'C 取消');
  } finally {
    await app.close();
  }
});

// ---- D. codex 節點 ----

test('D：codex 節點跑得完，點節點看得到它的輸出', async () => {
  test.setTimeout(420_000);
  const work = workDir('codex');
  const { app, window } = await launch(seededUserData('codex'));

  try {
    await startRun(window, CODEX.id, 'Reply with exactly CODEX_WF_OK', work);
    await expect(status(window)).toHaveText('完成', { timeout: 360_000 });
    await expect(node(window, 'end').locator('.session-dot')).toHaveClass(/done/);

    await node(window, 'agent-1').click();
    await expect.poll(() => screenText(window), { timeout: 20_000 }).toContain('CODEX_WF_OK');

    await window.screenshot({ path: join(root, 'test-results', 'wf-d-codex.png') });
    await reportUsage(window, 'D codex');
  } finally {
    await app.close();
  }
});

// ---- E. 角色真的送到 CLI ----

test('E：節點的角色會變成 CLI 的前置指示', async () => {
  test.setTimeout(360_000);
  const work = workDir('role');
  const { app, window } = await launch(seededUserData('role'));

  try {
    await startRun(window, ROLE.id, '說明角色', work);
    await expect(status(window)).toHaveText('完成', { timeout: 300_000 });
    await expect(node(window, 'agent-1').locator('.role-tag')).toHaveText('審查者');

    await node(window, 'agent-1').click();
    await expect.poll(() => screenText(window), { timeout: 20_000 }).toContain('審查者');

    await window.screenshot({ path: join(root, 'test-results', 'wf-e-role.png') });
    await reportUsage(window, 'E 角色');
  } finally {
    await app.close();
  }
});

// ---- F. 「Agent 任務」對話框的角色 ----

test('F：Agent 任務選了角色，CLI 也吃得到', async () => {
  test.setTimeout(360_000);
  const work = workDir('role-dialog');
  const { app, window } = await launch(seededUserData('role-dialog'));

  try {
    await window.click('#btn-new');
    await expect(window.locator('#new-connection')).toBeVisible();
    await window.selectOption('#f-type', 'agent');
    await window.selectOption('#f-agent-kind', 'claude');
    await pickRole(window, '#f-agent-role-pick', '審查', '審查者');
    // 審查者的預設是唯讀。
    await expect(window.locator('#f-agent-permission')).toHaveValue('readonly');
    await window.fill('#f-agent-prompt', '用一句話說明你現在扮演的角色');
    await window.fill('#f-cwd', work);
    await window.click('#f-ok');

    await expect.poll(() => screenText(window), { timeout: 60_000 }).toContain('[claude] 任務：');
    await expect.poll(() => screenText(window), { timeout: 300_000 }).toContain('審查者');
    await expect.poll(() => screenText(window), { timeout: 60_000 }).toContain('✔ 完成');

    await window.screenshot({ path: join(root, 'test-results', 'wf-f-role-dialog.png') });
  } finally {
    await app.close();
  }
});
