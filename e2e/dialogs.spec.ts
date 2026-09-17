import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { join } from 'node:path';
import { activeRows, expectAlive, freshUserData, launchApp, root } from './helpers';

const userData = freshUserData('dialogs');

const shot = (window: Page, name: string) =>
  window.screenshot({ path: join(root, 'test-results', `dialogs-${name}.png`) });

// 驗證的測試共用同一個 app：它們都不該建立出任何工作階段。
// 刻意不用 serial —— 一個失敗不該讓其他的驗證變成「沒跑」。
test.describe('新連接對話框的驗證', () => {
  let app: ElectronApplication;
  let window: Page;
  let dialogs: string[];

  test.beforeAll(async () => {
    const launched = await launchApp(userData);
    app = launched.app;
    window = launched.window;
    dialogs = [];
    window.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
  });

  test.afterAll(async () => {
    await app.close();
  });

  /**
   * 不管上一個測試留下什麼，都回到「對話框關著、沒有工作階段」。
   * 「取消」有時候關不掉 (見連接埠 70000 那個測試)，所以最後直接 close()。
   */
  test.afterEach(async () => {
    if (await window.locator('#new-connection').isVisible()) {
      await window.click('#f-cancel');
      await window.evaluate(() =>
        document.querySelector<HTMLDialogElement>('#new-connection')?.close(),
      );
      await expect(window.locator('#new-connection')).toBeHidden();
    }
    for (const close of await window.locator('.session-item .session-close').all()) {
      await close.click();
    }
    await expect(window.locator('.session-item')).toHaveCount(0);
  });

  /** 打開對話框、選類型、把會用到的欄位重設乾淨。*/
  async function openDialog(type: string): Promise<void> {
    await window.click('#btn-new');
    await expect(window.locator('#new-connection')).toBeVisible();
    await window.selectOption('#f-type', type);
    await window.fill('#f-name', '');
    await window.fill('#f-cwd', '');
  }

  test('SSH 沒填主機：對話框不關，顯示「請輸入主機位址」', async () => {
    await openDialog('ssh');
    await window.fill('#f-host', '');
    await window.fill('#f-user', 'someone');
    await window.fill('#f-port', '22');

    await window.click('#f-ok');

    await expect(window.locator('#new-connection')).toBeVisible();
    await expect(window.locator('#f-errors')).toHaveText('請輸入主機位址');
    await expect(window.locator('.session-item')).toHaveCount(0);
    await shot(window, 'ssh-no-host');
  });

  test('SSH 連接埠 70000：對話框不關，顯示「連接埠必須介於 1 到 65535」', async () => {
    await openDialog('ssh');
    await window.fill('#f-host', 'example.invalid');
    await window.fill('#f-user', 'someone');
    await window.fill('#f-port', '70000');

    await window.click('#f-ok');

    await expect(window.locator('#new-connection')).toBeVisible();
    await expect(window.locator('#f-errors')).toHaveText('連接埠必須介於 1 到 65535');
    await expect(window.locator('.session-item')).toHaveCount(0);
    await shot(window, 'ssh-port-70000');

    // 填了超出範圍的值之後，「取消」也要關得掉 —— 不然使用者被關在對話框裡。
    await window.click('#f-cancel');
    const state = await window.evaluate(() => {
      const port = document.querySelector<HTMLInputElement>('#f-port');
      const form = document.querySelector<HTMLFormElement>('#new-connection form');
      return {
        open: document.querySelector<HTMLDialogElement>('#new-connection')?.open === true,
        portValid: port?.checkValidity(),
        portMessage: port?.validationMessage,
        formValid: form?.checkValidity(),
      };
    });
    expect(state.open, `按「取消」之後的狀態：${JSON.stringify(state)}`).toBe(false);
  });

  test('自訂命令沒填執行檔：對話框不關，顯示「請輸入執行檔」', async () => {
    await openDialog('custom');
    await window.fill('#f-file', '');
    await window.fill('#f-args', '');

    await window.click('#f-ok');

    await expect(window.locator('#new-connection')).toBeVisible();
    await expect(window.locator('#f-errors')).toHaveText('請輸入執行檔');
    await expect(window.locator('.session-item')).toHaveCount(0);
    await shot(window, 'custom-no-file');
  });

  test('Agent 任務沒填任務：對話框不關，顯示「請輸入任務內容」', async () => {
    await openDialog('agent');
    // 權限預設是最保守的唯讀；三檔都在下拉裡。
    await expect(window.locator('#f-agent-permission')).toHaveValue('readonly');
    await expect(window.locator('#f-agent-permission option')).toHaveCount(3);
    await window.fill('#f-agent-prompt', '');

    await window.click('#f-ok');

    await expect(window.locator('#new-connection')).toBeVisible();
    await expect(window.locator('#f-errors')).toHaveText('請輸入任務內容');
    await expect(window.locator('.session-item')).toHaveCount(0);
    await shot(window, 'agent-no-prompt');
  });

  /** 欄位裡按 Enter 是「隱含送出」，瀏覽器挑的是第一個送出鍵。*/
  test('在名稱欄位按 Enter 等於按「建立」，不是取消', async () => {
    await openDialog('powershell');
    await window.fill('#f-name', 'Enter 建立的');
    await window.locator('#f-name').press('Enter');

    await expect(window.locator('#new-connection')).toBeHidden();
    await expect(window.locator('.session-item')).toHaveCount(1);
    await expect(window.locator('.session-item')).toContainText('Enter 建立的');
    await shot(window, 'enter-creates');
  });

  test('以上驗證都沒有跳出 alert，視窗還有反應', async () => {
    expect(dialogs).toEqual([]);
    await expectAlive(app, window);
  });
});

/**
 * 連接埠打 abc。自己開一個 app —— 目前的行為會真的送出去連線，
 * 那個工作階段 (與可能的 alert) 不該弄髒上面那一組驗證。
 */
test('SSH 連接埠 abc：對話框不關，顯示連接埠的錯誤', async () => {
  test.setTimeout(90_000);
  const { app, window } = await launchApp(userData);
  const dialogs: string[] = [];
  window.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  await window.click('#btn-new');
  await window.selectOption('#f-type', 'ssh');
  await window.fill('#f-name', '');
  await window.fill('#f-host', 'example.invalid');
  await window.fill('#f-user', 'someone');
  // type=number 不能用 fill 塞非數字，改用鍵盤模擬真的使用者。
  await window.locator('#f-port').fill('');
  await window.locator('#f-port').pressSequentially('abc');

  await window.click('#f-ok');
  await window.waitForTimeout(1500);
  await shot(window, 'ssh-port-abc');

  const observed =
    `#f-port 的 value = ${JSON.stringify(await window.locator('#f-port').inputValue())}，` +
    `對話框 visible = ${await window.locator('#new-connection').isVisible()}，` +
    `工作階段 = ${await window.locator('.session-item').count()}，` +
    `alert = ${JSON.stringify(dialogs)}`;

  expect(await window.locator('#new-connection').isVisible(), observed).toBe(true);
  await expect(window.locator('#f-errors')).toContainText('連接埠');
  await expect(window.locator('.session-item')).toHaveCount(0);

  await app.close();
});

test('WSL 指定不存在的發行版：終端機裡看得到錯誤，app 不會掛掉', async () => {
  test.setTimeout(90_000);
  const { app, window } = await launchApp(userData);
  const dialogs: string[] = [];
  window.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  await window.click('#btn-new');
  await window.selectOption('#f-type', 'wsl');
  await window.fill('#f-distro', 'NoSuchDistro');
  await window.click('#f-ok');
  await expect(window.locator('#new-connection')).toBeHidden();

  // 工作階段真的被建立出來了，而且很快就結束
  await expect(window.locator('.session-item')).toHaveCount(1);
  await expect(window.locator('.session-item')).toContainText('已結束', { timeout: 40_000 });
  // 終端機裡要看得到 wsl.exe 的錯誤訊息，不能只是一片空白
  await expect(activeRows(window)).toContainText('[工作階段已結束]', { timeout: 40_000 });
  const text = await activeRows(window).innerText();
  await shot(window, 'wsl-bad-distro');
  expect(
    text.replace('[工作階段已結束]', '').trim().length,
    `終端機裡沒有任何錯誤訊息，只有結束提示：\n${text}`,
  ).toBeGreaterThan(0);

  // 沒有原生錯誤對話框、視窗還有反應
  expect(dialogs).toEqual([]);
  await expectAlive(app, window);
  await window.click('#btn-new');
  await expect(window.locator('#new-connection')).toBeVisible();
  await window.click('#f-cancel');

  await app.close();
});
