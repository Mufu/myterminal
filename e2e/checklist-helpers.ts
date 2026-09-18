import { _electron as electron, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './helpers';

/**
 * 手動檢查表 (docs/MANUAL-TEST) 自動化那幾份 spec 共用的小工具。
 * 跟 helpers.ts 的差別：這裡的 launch 收的是「完整的」環境變數，
 * 所以拿得掉 PATH 裡的某一段、或把 USERPROFILE 換成暫存目錄。
 */

/** test-results 底下一個全新的目錄。*/
export function freshDir(name: string): string {
  const dir = join(root, 'test-results', name);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 上前一次的 Electron 可能還鎖著目錄，留著也無妨。
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 紀錄檔一律寫到 test-results，不碰 %USERPROFILE%\myterminal-logs。*/
export const LOG_DIR = join(root, 'test-results', 'checklist-logs');

/**
 * process.env 的副本：先拿掉 drop 裡的鍵 (Windows 的鍵不分大小寫，所以比對也不分)，
 * 再蓋上 set。PATH 要換的話 set 裡寫 PATH 就好 —— 原本的 Path 會先被 drop 掉。
 */
export function envWith(
  set: Record<string, string> = {},
  drop: string[] = [],
): Record<string, string> {
  const gone = new Set([...drop, ...Object.keys(set)].map((key) => key.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !gone.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, MYTERMINAL_LOG_DIR: LOG_DIR, ...set };
}

export interface Launched {
  app: ElectronApplication;
  window: Page;
  /** alert / confirm 的訊息；confirm 一律按確定 (accept)。*/
  dialogs: string[];
}

export async function launch(
  userData: string,
  options: { env?: Record<string, string>; big?: boolean; executablePath?: string } = {},
): Promise<Launched> {
  mkdirSync(LOG_DIR, { recursive: true });
  const app = await electron.launch({
    ...(options.executablePath
      ? { executablePath: options.executablePath, args: [`--user-data-dir=${userData}`] }
      : { args: ['.', `--user-data-dir=${userData}`], cwd: root }),
    env: options.env ?? envWith(),
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  const dialogs: string[] = [];
  window.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept();
  });
  if (options.big) {
    // 新節點排在最右邊，1280 的預設視窗放不下。
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1000 });
    });
  }
  return { app, window, dialogs };
}

/** 作用中的終端機的文字 (沒有終端機時是空字串)。*/
export const screenText = (window: Page): Promise<string> =>
  window
    .locator('.term-host:not([hidden]) .xterm-rows')
    .innerText()
    .catch(() => '');

/** 新連接：選類型、填欄位、按建立。*/
export async function newSession(
  window: Page,
  type: string,
  fill: () => Promise<void> = async () => {},
): Promise<void> {
  await window.click('#btn-new');
  await expect(window.locator('#new-connection')).toBeVisible();
  await window.selectOption('#f-type', type);
  await fill();
  await window.click('#f-ok');
}

/** 打一行字進作用中的終端機。*/
export async function typeLine(window: Page, text: string): Promise<void> {
  await window.locator('.term-host:not([hidden]) .xterm-screen').click();
  await window.keyboard.type(text);
  await window.keyboard.press('Enter');
}

/** 四個 CLI 晶片都探完 (不是「偵測中…」)。*/
export async function waitProbed(window: Page, timeout = 30_000): Promise<void> {
  for (const id of ['claude', 'codex', 'muse', 'opencode']) {
    await expect(window.locator(`#cli-${id}`)).not.toContainText('偵測中', { timeout });
  }
}

// ---- 畫布 ----

export const card = (id: string): string => `.wf-node[data-id="${id}"]`;
export const out = (id: string, port?: string): string =>
  port === undefined ? `${card(id)} .wf-port.out` : `${card(id)} .wf-port.out[data-port="${port}"]`;
export const inPort = (id: string): string => `${card(id)} .wf-port.in`;

export async function centre(window: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await window.locator(selector).boundingBox();
  if (!box) throw new Error(`量不到 ${selector} 的位置`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** 從一個接點拖到另一個點：pointer 事件要有中間的移動才像真的拖曳。*/
export async function wireTo(
  window: Page,
  fromSelector: string,
  to: { x: number; y: number },
): Promise<void> {
  const from = await centre(window, fromSelector);
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  await window.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await window.mouse.move(to.x, to.y, { steps: 5 });
  await window.mouse.up();
}

export async function wire(window: Page, fromSelector: string, toSelector: string): Promise<void> {
  await wireTo(window, fromSelector, await centre(window, toSelector));
}

/** 畫布座標 (0,0) 在螢幕上的位置 —— #editor-viewport 被 pan 平移過。*/
export async function viewportOrigin(window: Page): Promise<{ x: number; y: number }> {
  const box = await window.locator('#editor-viewport').boundingBox();
  if (!box) throw new Error('量不到畫布的位置');
  return { x: box.x, y: box.y };
}

/** 把節點拖到指定的畫布座標 (抓標頭，那裡沒有接點)。*/
export async function dragNodeTo(window: Page, id: string, x: number, y: number): Promise<void> {
  const box = await window.locator(card(id)).boundingBox();
  if (!box) throw new Error(`量不到節點 ${id}`);
  const origin = await viewportOrigin(window);
  await window.mouse.move(box.x + 40, box.y + 8);
  await window.mouse.down();
  await window.mouse.move(origin.x + x + 40, origin.y + y + 8, { steps: 6 });
  await window.mouse.up();
}
