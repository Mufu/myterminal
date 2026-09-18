import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { expectAlive, freshUserData, launchApp, root } from './helpers';

const shot = (window: Page, name: string) =>
  window.screenshot({ path: join(root, 'test-results', `assistant-${name}.png`) });

const panel = (window: Page) => window.locator('#assistant-panel');
const bots = (window: Page) => window.locator('.assistant-msg.bot');

/**
 * 把 claude 從 PATH 上拿掉，登入探測就會探不到它 —— 助理那一側因此是「未登入」。
 * Windows 的環境變數不分大小寫，但 launchApp 是用展開合併的，
 * 所以兩種拼法都要蓋掉 (值一樣，Windows 挑哪一個都無所謂)。
 */
const WITHOUT_CLAUDE = {
  PATH: 'C:\\Windows\\System32',
  Path: 'C:\\Windows\\System32',
};

test('助理：按鈕開關同一格，建議填進輸入框', async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(freshUserData('assistant'));

  // 一開始是關的，按鈕沒有被按下。
  await expect(panel(window)).toBeHidden();
  await expect(window.locator('#btn-assistant')).toHaveAttribute('aria-pressed', 'false');

  await window.click('#btn-assistant');
  await expect(panel(window)).toBeVisible();
  await expect(window.locator('#btn-assistant')).toHaveAttribute('aria-pressed', 'true');
  await expect(window.locator('#assistant-head h2')).toContainText('助理 · Sonnet');
  await shot(window, 'open');

  // 三顆建議：按下去只是填進輸入框，送不送由人決定。
  await expect(window.locator('.assistant-chip')).toHaveCount(3);
  await window.locator('.assistant-chip', { hasText: '角色庫怎麼設定？' }).click();
  await expect(window.locator('#assistant-input')).toHaveValue('角色庫怎麼設定？');
  await expect(bots(window)).toHaveCount(0);

  // 關掉再開還是同一個元素 (不是每次開一個新面板)。
  await window.click('#assistant-close');
  await expect(panel(window)).toBeHidden();
  await expect(window.locator('#btn-assistant')).toHaveAttribute('aria-pressed', 'false');
  await window.click('#btn-assistant');
  await window.click('#btn-assistant');
  await window.click('#btn-assistant');
  await expect(panel(window)).toBeVisible();
  await expect(panel(window)).toHaveCount(1);
  // 輸入框裡的字也還在 —— 面板從頭到尾就只有那一個。
  await expect(window.locator('#assistant-input')).toHaveValue('角色庫怎麼設定？');

  await expectAlive(app, window);
  await app.close();
});

test('助理：Claude 沒登入時直接說原因，「新對話」把訊息清掉', async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(freshUserData('assistant-logged-out'), WITHOUT_CLAUDE);

  await window.click('#btn-assistant');
  await window.fill('#assistant-input', '怎麼開 WSL 工作階段？');
  await window.click('#assistant-send');

  // 問題本身照樣進畫面，答案那一顆泡泡寫的是原因。
  await expect(window.locator('.assistant-msg.user')).toHaveText('怎麼開 WSL 工作階段？');
  await expect(window.locator('.assistant-msg.error')).toContainText(
    'Claude 尚未登入，請先在「CLI 設定」登入',
    { timeout: 30_000 },
  );
  await shot(window, 'logged-out');

  // 「新對話」：訊息全部清掉，空狀態與三顆建議回來。
  await window.click('#assistant-reset');
  await expect(window.locator('.assistant-msg')).toHaveCount(0);
  await expect(window.locator('#assistant-empty')).toBeVisible();
  await expect(window.locator('.assistant-chip')).toHaveCount(3);

  await expectAlive(app, window);
  await app.close();
});

test('助理：真的問兩句，第二句接得上前一句', async () => {
  // 真的呼叫 claude (Sonnet)：會用掉訂閱方案的額度，所以預設不跑。
  test.skip(!process.env.MYTERMINAL_ASSISTANT_E2E, '會用 Claude 額度');
  test.setTimeout(300_000);

  const { app, window } = await launchApp(freshUserData('assistant-live'));
  await window.click('#btn-assistant');

  // 第一句：答案要講到「新連接」與 WSL。
  await window.fill('#assistant-input', '怎麼開一個 WSL 工作階段？');
  await window.click('#assistant-send');
  await expect(window.locator('#assistant-status')).toHaveText('回答中…');
  await expect(bots(window).first()).toContainText('新連接', { timeout: 180_000 });
  await expect(bots(window).first()).toContainText('WSL');

  // 回答完輸入框才解鎖，狀態那一行從「回答中…」換成金額與耗時。
  await expect(window.locator('#assistant-input')).toBeEnabled({ timeout: 60_000 });
  await expect(window.locator('#assistant-cancel')).toBeHidden();
  await expect(window.locator('#assistant-status')).toContainText('$', { timeout: 10_000 });

  const first = await bots(window).first().innerText();
  const firstUsage = await window.locator('#assistant-status').innerText();
  console.log(`\n=== 第一題：怎麼開一個 WSL 工作階段？ (${firstUsage}) ===\n${first}\n`);
  await shot(window, 'answer-1');

  // 第二句只有「那 SSH 呢？」—— 接得上前一句才答得出 plink / 主機。
  await window.fill('#assistant-input', '那 SSH 呢？');
  await window.click('#assistant-send');
  await expect(bots(window)).toHaveCount(2, { timeout: 30_000 });
  await expect(bots(window).nth(1)).toContainText(/plink|主機/, { timeout: 180_000 });
  await expect(window.locator('#assistant-input')).toBeEnabled({ timeout: 60_000 });
  await expect(window.locator('#assistant-status')).toContainText('$', { timeout: 10_000 });
  const second = await bots(window).nth(1).innerText();
  const secondUsage = await window.locator('#assistant-status').innerText();
  console.log(`\n=== 第二題：那 SSH 呢？ (${secondUsage}) ===\n${second}\n`);
  await shot(window, 'answer-2');

  await expectAlive(app, window);
  await app.close();
});
