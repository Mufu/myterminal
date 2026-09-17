import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { activeRows, freshUserData, launchApp, root } from './helpers';

const userData = freshUserData('cjk-ime');
/** 紀錄檔寫到 test-results 底下，不要碰使用者自己的 %USERPROFILE%\myterminal-logs。*/
const logDir = join(root, 'test-results', 'cjk-ime-logs');
rmSync(logDir, { recursive: true, force: true });
mkdirSync(logDir, { recursive: true });

const shot = (window: Page, name: string) =>
  window.screenshot({ path: join(root, 'test-results', `cjk-ime-${name}.png`) });

/** xterm 收 IME 事件的那個隱藏輸入區。*/
const TERM_TEXTAREA = '.term-host:not([hidden]) .xterm-helper-textarea';

async function openWithSession(): Promise<{ app: ElectronApplication; window: Page }> {
  const { app, window } = await launchApp(userData, { MYTERMINAL_LOG_DIR: logDir });
  window.on('dialog', (dialog) => void dialog.dismiss());
  await window.click('#btn-new');
  await window.selectOption('#f-type', 'powershell');
  await window.click('#f-ok');
  await expect(activeRows(window)).toContainText('PS ', { timeout: 30_000 });
  return { app, window };
}

/**
 * 重播一段 Windows 注音的 IME 事件：compositionstart → 中間的注音符號
 * → compositionend 交出整個字。合成事件不會自己改 textarea 的值，
 * 所以要一起改 —— xterm 的 CompositionHelper 讀的就是 textarea.value。
 */
async function imeType(
  window: Page,
  selector: string,
  steps: string[],
  final: string,
): Promise<void> {
  await window.evaluate(
    ([selector, steps, final]) => {
      const ta = document.querySelector<HTMLTextAreaElement>(selector as string);
      if (!ta) throw new Error(`找不到 ${selector as string}`);
      ta.focus();
      const base = ta.value;
      const fire = (e: Event) => ta.dispatchEvent(e);
      fire(new KeyboardEvent('keydown', { keyCode: 229, key: 'Process', bubbles: true }));
      fire(new CompositionEvent('compositionstart', { data: '', bubbles: true, composed: true }));
      for (const s of [...(steps as string[]), final as string]) {
        ta.value = base + s;
        fire(new CompositionEvent('compositionupdate', { data: s, bubbles: true, composed: true }));
        fire(
          new InputEvent('input', {
            inputType: 'insertCompositionText',
            data: s,
            isComposing: true,
            bubbles: true,
            composed: true,
          }),
        );
      }
      fire(
        new CompositionEvent('compositionend', {
          data: final as string,
          bubbles: true,
          composed: true,
        }),
      );
      fire(new KeyboardEvent('keyup', { keyCode: 229, key: 'Process', bubbles: true }));
    },
    [selector, steps, final] as const,
  );
  // CompositionHelper 是在 setTimeout(0) 裡才把整串交出去的。
  await window.waitForTimeout(300);
}

test('注音組字：中間的注音符號不會送進 shell，選完字整個中文字才進去', async () => {
  const { app, window } = await openWithSession();
  await window.locator('.term-host:not([hidden]) .xterm-screen').click();

  await window.keyboard.type('echo ');
  await imeType(window, TERM_TEXTAREA, ['ㄋ', 'ㄋㄧ', 'ㄋㄧˇ'], '你');
  await imeType(window, TERM_TEXTAREA, ['ㄏ', 'ㄏㄠ', 'ㄏㄠˇ'], '好');

  // 組字中間的注音符號不可以跑進命令列，而且中文字不可以重複。
  await expect(activeRows(window)).toContainText('echo 你好');
  const typed = await activeRows(window).innerText();
  expect(typed, typed).not.toContain('ㄋ');
  expect(typed, typed).not.toContain('你你');
  await shot(window, 'typed');

  await window.keyboard.press('Enter');
  // 回顯一次 + 輸出一次。
  await expect
    .poll(async () => ((await activeRows(window).innerText()).match(/你好/g) ?? []).length, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(2);
  const after = await activeRows(window).innerText();
  expect(after, after).toContain('\n你好');
  await shot(window, 'executed');
  await app.close();
});

test('輸入字：面板打開之後焦點留在輸入區，注音打的字不會跑進終端機', async () => {
  const { app, window } = await openWithSession();

  await window.click('#btn-input');
  await expect(window.locator('#input-panel')).toBeVisible();
  // 以前 syncTerminals() 會在面板 focus 之後又把焦點搶回終端機，
  // 使用者用注音打的字整串跑進 shell 的命令列。
  await expect(window.locator('#input-text')).toBeFocused();

  await window.keyboard.type('echo ');
  await imeType(window, '#input-text', ['ㄈ', 'ㄈㄨˊ'], '福');
  await expect(window.locator('#input-text')).toHaveValue('echo 福');
  const term = await activeRows(window).innerText();
  expect(term, term).not.toContain('福');
  await shot(window, 'panel-focus');
  await app.close();
});

test('輸入字：工作階段狀態變動不會把焦點搶到終端機', async () => {
  const { app, window } = await openWithSession();

  await window.click('#btn-input');
  await expect(window.locator('#input-text')).toBeFocused();
  await window.keyboard.type('echo 半形');

  // 開紀錄會讓 main 廣播 sessionsChanged，renderer 整個重新同步一次；
  // 以前這一趟會把焦點搶到終端機，正在組的字就斷在半路。
  await window.click('#btn-log');
  await expect(window.locator('#btn-log')).toHaveClass(/on/);

  await expect(window.locator(TERM_TEXTAREA)).not.toBeFocused();
  await expect(window.locator('#input-text')).toHaveValue('echo 半形');
  await app.close();
});

test('輸入字：面板收起來之後焦點回到終端機', async () => {
  const { app, window } = await openWithSession();

  await window.click('#btn-input');
  await expect(window.locator('#input-text')).toBeFocused();
  await window.click('#btn-input');
  await expect(window.locator('#input-panel')).toBeHidden();

  await expect(window.locator(TERM_TEXTAREA)).toBeFocused();
  await window.keyboard.type('echo BACK_TO_TERM');
  await expect(activeRows(window)).toContainText('echo BACK_TO_TERM');
  await app.close();
});
