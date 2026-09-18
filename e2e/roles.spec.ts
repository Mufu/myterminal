import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshUserData, launchApp, pickRole, root } from './helpers';

/**
 * 角色庫的端到端：指一個資料夾，裡面的 markdown 就是角色。
 * 全程不碰 claude / codex —— Agent 任務那一筆的工作目錄指到一個不存在的
 * 目錄，SessionManager 會在 spawn 之前就擋下來，所以不花錢。
 *
 * 「瀏覽…」開的是 Electron 原生的選資料夾對話框，Playwright 點不到它，
 * 所以這裡改用旁邊那個路徑欄位 (打完按 Enter 就換資料夾)；
 * 原生對話框本身留給 docs/MANUAL-TEST.md 的 G14。
 */

const userData = freshUserData('roles');
/** main 沒設定過角色資料夾時就是 userData/roles，所以直接種在那裡。*/
const rolesDir = join(userData, 'roles');

const shot = (window: Page, name: string) =>
  window.screenshot({ path: join(root, 'test-results', `roles-${name}.png`) });

const roleFile = (name: string, emoji: string, description: string): string =>
  `---\nname: ${name}\nemoji: ${emoji}\ndescription: ${description}\n---\n# ${name}\n\nYou are ${name}. Reply in one line.\n`;

function seedRoles(): void {
  mkdirSync(join(rolesDir, 'engineering'), { recursive: true });
  mkdirSync(join(rolesDir, 'testing'), { recursive: true });
  writeFileSync(
    join(rolesDir, 'engineering', 'x.md'),
    roleFile('Lib Coder', '🧰', 'Writes the thing'),
    'utf8',
  );
  writeFileSync(
    join(rolesDir, 'testing', 'y.md'),
    roleFile('Lib Tester', '🧪', 'Breaks the thing'),
    'utf8',
  );
  // 沒有 frontmatter，掃描時要被略過。
  writeFileSync(join(rolesDir, 'README.md'), '# 我的角色庫\n\n放角色檔的地方。\n', 'utf8');
}

seedRoles();

// 第二、三個測試靠前面存下來的 profiles.json 與 workflows.json，必須照順序跑。
test.describe.configure({ mode: 'serial' });

test('Agent 任務選得到角色庫的角色，權限跟著跳成唯讀', async () => {
  const { app, window } = await launchApp(userData);
  try {
    await window.click('#btn-new');
    await expect(window.locator('#new-connection')).toBeVisible();
    await window.selectOption('#f-type', 'agent');

    // 角色庫掃出兩個角色，README 被略過。
    await window.click('#f-agent-role-pick');
    await expect(window.locator('#role-picker')).toBeVisible();
    await expect(window.locator('#roles-dir')).toHaveValue(rolesDir);
    await expect(window.locator('#roles-status')).toHaveText('2 個角色（1 個檔案略過）');
    await window.click('#roles-skipped summary');
    await expect(window.locator('#roles-skipped-list li')).toHaveText([
      'README.md — 沒有 frontmatter 的 name',
    ]);
    await shot(window, 'picker');

    // 搜尋 y 那一個，點下去就選好了。
    await window.fill('#role-search', 'y');
    await expect(window.locator('.role-row')).toHaveCount(1);
    await window.locator('.role-row').click();
    await expect(window.locator('#role-picker')).toBeHidden();

    await expect(window.locator('#f-agent-role-name')).toHaveText('🧪 Lib Tester');
    // 角色庫的角色一律是最保守的唯讀。
    await expect(window.locator('#f-agent-permission')).toHaveValue('readonly');

    // 存成設定檔。工作目錄故意指到不存在的地方，CLI 不會真的被叫起來。
    await window.fill('#f-name', '角色庫任務');
    await window.fill('#f-agent-prompt', '只回覆 OK');
    await window.fill('#f-cwd', join(userData, '沒有這個目錄'));
    await window.check('#f-save');
    await window.click('#f-ok');

    await expect(window.locator('#new-connection')).toBeHidden();
    const row = window.locator('#profile-list .profile-item', { hasText: '角色庫任務' });
    await expect(row.locator('.role-tag')).toHaveText('🧪 Lib Tester');
  } finally {
    await app.close();
  }
});

test('重新啟動之後，設定檔那一列仍然貼著角色庫的角色', async () => {
  const { app, window } = await launchApp(userData);
  try {
    const row = window.locator('#profile-list .profile-item', { hasText: '角色庫任務' });
    await expect(row).toHaveCount(1);
    // 角色是開機掃出來才認得的，所以這一列要等 roles:list 回來。
    await expect(row.locator('.role-tag')).toHaveText('🧪 Lib Tester');
    await shot(window, 'profile');
  } finally {
    await app.close();
  }
});

test('畫布的節點選得到角色庫的角色，資料夾不見之後存檔會擋下來', async () => {
  const { app, window } = await launchApp(userData);
  try {
    // 新節點預設放在最右邊那個節點的右側，1280 的預設視窗放不下，開大一點。
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 });
    });

    await window.click('#btn-workflow-edit');
    await expect(window.locator('#workflow-editor')).toBeVisible();
    await window.click('#btn-add-agent');
    await window.click('.wf-node[data-id="agent-1"] .wf-node-body');

    await pickRole(window, '#props-role-pick', 'Lib Coder', 'Lib Coder');
    await expect(window.locator('#props-role')).toHaveText('🧰 Lib Coder');
    await expect(window.locator('.wf-node[data-id="agent-1"] .role-tag')).toHaveText('🧰 Lib Coder');

    await window.fill('#props-prompt', '{{params.task}}');
    await window.fill('#props-cwd', '{{params.cwd}}');

    await wire(
      window,
      '.wf-node[data-id="start"] .wf-port.out',
      '.wf-node[data-id="agent-1"] .wf-port.in',
    );
    await wire(
      window,
      '.wf-node[data-id="agent-1"] .wf-port.out[data-port="ok"]',
      '.wf-node[data-id="end"] .wf-port.in',
    );

    await window.fill('#editor-name', '角色庫流程');
    await window.click('#btn-editor-save');
    await expect(window.locator('#editor-errors')).toBeHidden();
    await shot(window, 'editor');

    // 存出去的定義裡就是那個 lib: id。
    const saved = readFileSync(join(userData, 'workflows.json'), 'utf8');
    expect(saved).toContain('lib:engineering/x');

    // 資料夾被搬走 (或砍掉) 之後重新掃描：角色就不見了。
    rmSync(rolesDir, { recursive: true, force: true });
    await window.click('#props-role-pick');
    await expect(window.locator('#role-picker')).toBeVisible();
    await window.click('#roles-rescan');
    await expect(window.locator('#roles-status')).toHaveText('0 個角色（0 個檔案略過）');
    await window.click('#role-picker-close');
    await expect(window.locator('#role-picker')).toBeHidden();

    // 節點還留著那個 id，但存檔時驗證擋下來，而且說得出是角色庫的問題。
    await window.click('#btn-editor-save');
    await expect(window.locator('#editor-errors')).toBeVisible();
    await expect(window.locator('#editor-errors')).toContainText(
      '節點 agent-1 的角色不存在：lib:engineering/x（角色庫裡找不到，確認角色資料夾）',
    );
    await shot(window, 'missing');
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
