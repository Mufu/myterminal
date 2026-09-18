import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { join, win32 } from 'node:path';
import { expectAlive, root } from './helpers';
import {
  card,
  freshDir,
  inPort,
  launch,
  newSession,
  out,
  screenText,
  typeLine,
  wire,
} from './checklist-helpers';

/**
 * 手動檢查表 A4、B3、C4、C10、C11、C12。不碰任何 CLI，只開 PowerShell / WSL / cmd。
 * 每個案例自己的 userData (test-results/checklist-<id>)。
 */

const shot = (window: Page, name: string) =>
  window.screenshot({ path: join(root, 'test-results', `${name}.png`) });

test('A4 視窗最小尺寸：縮不到 900×560 以下，清除畫面與主題選單還看得到、按得到', async () => {
  const { app, window, dialogs } = await launch(freshDir('checklist-a4'));
  try {
    await newSession(window, 'powershell');
    await expect(window.locator('.term-host:not([hidden]) .xterm-rows')).toContainText('PS ', {
      timeout: 30_000,
    });

    const min = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getMinimumSize(),
    );
    expect(min).toEqual([900, 560]);

    // 相當於把視窗往左上角拖到最小：要 400×300，OS 會停在最小尺寸。
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 400, height: 300 }),
    );
    await window.waitForTimeout(1000);
    const size = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getSize(),
    );
    console.log(`[A4] 要 400×300 之後視窗是 ${size[0]}×${size[1]}`);
    expect(size[0]).toBeGreaterThanOrEqual(900);
    expect(size[1]).toBeGreaterThanOrEqual(560);

    // 工具列最右邊那兩個都完整落在視窗裡。
    const viewport = await window.evaluate(() => globalThis.innerWidth);
    for (const selector of ['#btn-clear', '#theme-select']) {
      await expect(window.locator(selector)).toBeVisible();
      const box = await window.locator(selector).boundingBox();
      expect(box, selector).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0), selector).toBeLessThanOrEqual(viewport);
    }
    await shot(window, 'a4-min');

    // 按得到：清除畫面真的清掉，主題真的換掉。
    await typeLine(window, 'echo A4_MARK');
    await expect.poll(() => screenText(window), { timeout: 20_000 }).toMatch(/^A4_MARK\s*$/m);
    await window.click('#btn-clear');
    await expect.poll(() => screenText(window)).not.toContain('A4_MARK');
    await window.selectOption('#theme-select', 'light');
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');
    await window.selectOption('#theme-select', 'dark');

    expect(dialogs).toEqual([]);
    await expectAlive(app, window);
  } finally {
    await app.close();
  }
});

/** 一個元素實際看起來的底色：自己透明就往上找祖先。*/
async function effectiveBackground(window: Page, selector: string): Promise<number[]> {
  return window.locator(selector).first().evaluate((el) => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(e).backgroundColor);
      if (m) {
        const [r, g, b, a = 1] = m[1].split(',').map(Number);
        if (a > 0) return [r, g, b];
      }
    }
    return [255, 255, 255];
  });
}

async function colorOf(window: Page, selector: string, prop: 'color' | 'stroke'): Promise<number[]> {
  return window
    .locator(selector)
    .first()
    .evaluate((el, p) => {
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el)[p as 'color']);
      return m ? m[1].split(',').slice(0, 3).map(Number) : [0, 0, 0];
    }, prop);
}

/** WCAG 相對亮度 (0 黑 ~ 1 白)。*/
function luminance([r, g, b]: number[]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const contrast = (a: number[], b: number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('B3 淺色主題套到畫布、卡片、連線與新連接對話框，文字可讀', async () => {
  const { app, window, dialogs } = await launch(freshDir('checklist-b3'), { big: true });
  try {
    await window.selectOption('#theme-select', 'light');
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');

    await window.click('#btn-workflow-edit');
    await expect(window.locator('#workflow-editor')).toBeVisible();
    await window.click('#btn-add-agent');
    await wire(window, out('start'), inPort('agent-1'));
    await expect(window.locator('path.wf-edge')).toHaveCount(1);
    await shot(window, 'b3-editor');

    const measured: Record<string, string> = {};
    const editorBg = await effectiveBackground(window, '#workflow-editor');
    const canvasBg = await effectiveBackground(window, '#editor-canvas');
    const nodeBg = await effectiveBackground(window, card('agent-1'));
    const nodeText = await colorOf(window, `${card('agent-1')} .wf-node-label`, 'color');
    const edge = await colorOf(window, 'path.wf-edge', 'stroke');
    measured.editor = luminance(editorBg).toFixed(2);
    measured.canvas = luminance(canvasBg).toFixed(2);
    measured.node = luminance(nodeBg).toFixed(2);
    measured.nodeText = contrast(nodeText, nodeBg).toFixed(1);
    measured.edge = contrast(edge, canvasBg).toFixed(1);

    await window.click('#btn-new');
    await expect(window.locator('#new-connection')).toBeVisible();
    await shot(window, 'b3-dialog');
    const dialogBg = await effectiveBackground(window, '#new-connection');
    const dialogText = await colorOf(window, '#new-connection h2', 'color');
    measured.dialog = luminance(dialogBg).toFixed(2);
    measured.dialogText = contrast(dialogText, dialogBg).toFixed(1);
    console.log(`[B3] 亮度 / 對比：${JSON.stringify(measured)}`);

    expect(luminance(editorBg), '#workflow-editor 的底色').toBeGreaterThan(0.6);
    expect(luminance(canvasBg), '#editor-canvas 的底色').toBeGreaterThan(0.6);
    expect(luminance(nodeBg), '.wf-node 的底色').toBeGreaterThan(0.6);
    expect(luminance(dialogBg), '#new-connection 的底色').toBeGreaterThan(0.6);
    // 文字可讀 (WCAG AA 大字 3:1)，連線在淺底上看得見。
    expect(contrast(nodeText, nodeBg), '卡片文字對比').toBeGreaterThanOrEqual(3);
    expect(contrast(dialogText, dialogBg), '對話框標題對比').toBeGreaterThanOrEqual(3);
    expect(contrast(edge, canvasBg), '連線對比').toBeGreaterThanOrEqual(1.5);

    await window.click('#f-cancel');
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

test('C4 WSL 指定發行版 Ubuntu、工作目錄 /tmp：pwd 印出 /tmp', async () => {
  test.setTimeout(120_000);
  const { app, window, dialogs } = await launch(freshDir('checklist-c4'));
  try {
    await newSession(window, 'wsl', async () => {
      await window.fill('#f-distro', 'Ubuntu');
      await window.fill('#f-cwd', '/tmp');
    });
    await expect(window.locator('#new-connection')).toBeHidden();
    await expect.poll(() => screenText(window), { timeout: 40_000 }).toContain('$');
    await typeLine(window, 'pwd');
    await expect.poll(() => screenText(window), { timeout: 20_000 }).toMatch(/^\/tmp\s*$/m);
    await expect(window.locator('.session-item')).toContainText('WSL 1');
    await shot(window, 'c4-wsl-tmp');
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

test('C10 自訂命令的引號參數：cmd.exe /c echo "a b" c 不會多出反斜線', async () => {
  const { app, window, dialogs } = await launch(freshDir('checklist-c10'));
  try {
    await newSession(window, 'custom', async () => {
      await window.fill('#f-file', 'cmd.exe');
      await window.fill('#f-args', '/c echo "a b" c');
    });
    await expect.poll(() => screenText(window), { timeout: 20_000 }).toContain('[工作階段已結束]');
    const text = await screenText(window);
    console.log(`[C10] 終端機：${JSON.stringify(text.trim())}`);
    expect(text).toMatch(/^("a b" c|a b c)\s*$/m);
    expect(text).not.toContain('\\"');
    expect(dialogs).toEqual([]);
  } finally {
    await app.close();
  }
});

test('C11 不存在的執行檔：錯誤訊息帶檔名，不是 Error invoking remote method', async () => {
  const { app, window, dialogs } = await launch(freshDir('checklist-c11'));
  try {
    await newSession(window, 'custom', async () => {
      await window.fill('#f-file', 'no-such-exe-123');
      await window.fill('#f-args', '');
    });
    await expect.poll(() => dialogs.length, { timeout: 15_000 }).toBe(1);
    console.log(`[C11] 錯誤訊息：${JSON.stringify(dialogs[0])}`);
    expect(dialogs[0]).toContain('no-such-exe-123');
    expect(dialogs[0]).not.toContain('Error invoking remote method');
    await expect(window.locator('.session-item')).toHaveCount(0);
    await expectAlive(app, window);
  } finally {
    await app.close();
  }
});

test('C12 工作目錄不存在：顯示「工作目錄不存在：…」，不建立工作階段', async () => {
  const missing = win32.normalize('D:/no-such-dir-98765');
  const { app, window, dialogs } = await launch(freshDir('checklist-c12'));
  try {
    await newSession(window, 'powershell', async () => {
      await window.fill('#f-cwd', missing);
    });
    await expect.poll(() => dialogs.length, { timeout: 15_000 }).toBe(1);
    console.log(`[C12] 錯誤訊息：${JSON.stringify(dialogs[0])}`);
    expect(dialogs[0]).toContain(`工作目錄不存在：${missing}`);
    expect(dialogs[0]).not.toContain('Error invoking remote method');
    await expect(window.locator('.session-item')).toHaveCount(0);
    await expect(window.locator('#empty-hint')).toBeVisible();
    await expectAlive(app, window);
  } finally {
    await app.close();
  }
});
