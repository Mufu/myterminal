import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(__dirname, '..');

const HOST = process.env.MYTERMINAL_SSH_HOST ?? 'localhost';
const PORT = process.env.MYTERMINAL_SSH_PORT ?? '2222';
const LOGIN = process.env.MYTERMINAL_SSH_USER ?? 'mtssh';
const PASSWORD = process.env.MYTERMINAL_SSH_PASSWORD ?? 'mtssh-e2e';

// 要有一台真的 sshd 才跑得動，所以預設 skip；npm run e2e:ssh 會設好這個變數。
test.skip(
  !process.env.MYTERMINAL_SSH_E2E,
  '需要本機 WSL sshd：先執行 scripts/wsl-sshd-setup.sh',
);

/** 終端機畫面上看得到的文字。innerText 會保留每一列的換行，方便用 ^$ 斷言。*/
const screenText = (window: Page): Promise<string> =>
  window.locator('.xterm-rows').innerText();

/** 打一行字進終端機。xterm.js 的輸入其實是那個隱藏的 textarea。*/
async function typeLine(window: Page, text: string): Promise<void> {
  await window.locator('.xterm-helper-textarea').focus();
  await window.keyboard.type(text);
  await window.keyboard.press('Enter');
}

/** 目前所有 plink.exe 的 PID，用來確認工作階段結束後行程真的收掉了。*/
function plinkPids(): string[] {
  const out = execFileSync(
    'tasklist',
    ['/NH', '/FI', 'IMAGENAME eq plink.exe', '/FO', 'CSV'],
    { encoding: 'utf8' },
  );
  return [...out.matchAll(/^"plink\.exe","(\d+)"/gm)].map((m) => m[1]);
}

test('用新連接開一個 SSH 工作階段，登入、執行指令、離線', async () => {
  // WSL 冷啟動 + plink 交握 + 打字都很慢，給寬一點。
  test.setTimeout(240_000);

  const before = plinkPids();
  const app = await electron.launch({ args: ['.'], cwd: root });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  await window.click('#btn-new');
  await expect(window.locator('#new-connection')).toBeVisible();
  await window.selectOption('#f-type', 'ssh');
  await window.fill('#f-host', HOST);
  await window.fill('#f-port', PORT);
  await window.fill('#f-user', LOGIN);
  await window.click('#f-ok');

  // 第一次連這台主機時 plink 會問要不要把金鑰存進登錄檔；存過就直接跳到密碼。
  await expect
    .poll(() => screenText(window), { timeout: 90_000 })
    .toMatch(/Store key in cache\?|password:/);
  if (/Store key in cache\?/.test(await screenText(window))) {
    await typeLine(window, 'y');
  }

  await expect.poll(() => screenText(window), { timeout: 60_000 }).toContain('password:');
  await typeLine(window, PASSWORD);

  // bash 的預設提示字元 <user>@<host>:<cwd>$ 出來，代表 -no-antispoof 有效：
  // 沒有卡在 "Access granted. Press Return to begin session."。
  await expect
    .poll(() => screenText(window), { timeout: 90_000 })
    .toMatch(/@[\w.-]+:[^\n]*\$[ \t]*$/m);

  await typeLine(window, 'echo SSH_E2E_OK; hostname');
  // 被回顯的那一行是「提示字元 + echo SSH_E2E_OK; hostname」，
  // 所以整行剛好等於標記的只會是真正的輸出；下一行是 hostname 印出來的主機名。
  await expect
    .poll(() => screenText(window), { timeout: 60_000 })
    .toMatch(/^[ \t]*SSH_E2E_OK[ \t]*\n[ \t]*\S+[ \t]*$/m);

  await window.screenshot({ path: join(root, 'test-results', 'ssh.png') });

  await typeLine(window, 'exit');
  await expect(window.locator('.session-item')).toContainText('已結束 (0)', {
    timeout: 60_000,
  });
  await expect
    .poll(() => plinkPids().filter((pid) => !before.includes(pid)), { timeout: 30_000 })
    .toEqual([]);

  await app.close();
});
