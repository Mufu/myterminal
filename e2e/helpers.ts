import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const root = join(__dirname, '..');

/**
 * 每個 spec 自己的 userData 目錄。啟動前清掉，profiles.json 與 localStorage
 * 才不會被上一輪 (或開發機上真正的設定) 影響。
 */
export function freshUserData(name: string): string {
  const dir = join(root, 'test-results', `${name}-user-data`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
}

export async function launchApp(
  userData: string,
  /** 額外的環境變數，例如把紀錄檔目錄 (MYTERMINAL_LOG_DIR) 指到 test-results。*/
  env?: Record<string, string>,
): Promise<LaunchedApp> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: root,
    // process.env 的值可能是 undefined，Playwright 只收字串，所以先濾一次。
    ...(env ? { env: { ...defined(process.env), ...env } } : {}),
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}

/**
 * 只有作用中的那個終端機沒有 hidden。用它當範圍，.xterm-rows 才不會同時
 * 命中其他工作階段的終端機 (Playwright 的 strict mode 會直接報錯)。
 */
export const activeRows = (window: Page) =>
  window.locator('.term-host:not([hidden]) .xterm-rows');

/** 某個工作階段那一列。*/
export const sessionRow = (window: Page, name: string) =>
  window.locator('.session-item', { hasText: name });

/** 打字進作用中的終端機 (先點一下讓 xterm 拿到焦點)。*/
export async function runInTerminal(window: Page, command: string): Promise<void> {
  await window.locator('.term-host:not([hidden]) .xterm-screen').click();
  await window.keyboard.type(command);
  await window.keyboard.press('Enter');
}

/** 作用中終端機目前畫面上的純文字。*/
export async function activeText(window: Page): Promise<string> {
  return (await activeRows(window).innerText()) ?? '';
}

/**
 * app 還活著而且主行程沒有被原生錯誤對話框卡住。
 * 「A JavaScript error occurred」那種 message box 會擋住 main 的事件迴圈，
 * 於是 app.evaluate 永遠不回來 —— 所以這裡用逾時來偵測。
 */
export async function expectAlive(app: ElectronApplication, window: Page): Promise<void> {
  const windows = await Promise.race([
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('主行程沒有回應 (可能跳了原生錯誤對話框)')), 10_000),
    ),
  ]);
  if (windows < 1) throw new Error('視窗不見了');
  // renderer 也要還能跑 JS。
  const title = await window.title();
  if (!title) throw new Error('renderer 沒有回應');
}

/** 把 process.env 裡沒有值的項目拿掉。*/
function defined(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

/**
 * 角色欄位：按「選擇…」→ 在選擇器裡搜尋 → 點那一列。
 * pick 是那顆按鈕的 id (#props-role-pick 或 #f-agent-role-pick)，
 * name 是角色的顯示名稱 (選擇器上那一列的字)。
 */
export async function pickRole(
  window: Page,
  pick: string,
  query: string,
  name: string,
): Promise<void> {
  await window.click(pick);
  await window.fill('#role-search', query);
  await window.locator('.role-row', { hasText: name }).first().click();
}
