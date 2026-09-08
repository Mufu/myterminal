import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { SessionManager } from './session-manager';
import { SessionLogger, defaultLogDir, ensureLogDir } from './session-logger';
import { NodePtySpawner } from './node-pty-spawner';
import { ShellFactory } from './shell-factory';
import { registerIpc } from './ipc';

/** MYTERMINAL_SMOKE=1 時走冒煙測試流程：自動開一個 PowerShell、截圖、離開。*/
const SMOKE = process.env.MYTERMINAL_SMOKE === '1';

let win: BrowserWindow | null = null;

const logDir = defaultLogDir();
ensureLogDir(logDir);

// 組裝：正式環境注入真的 node-pty spawner 與真的檔案 sink。
const manager = new SessionManager(new NodePtySpawner(), new ShellFactory());
const logger = new SessionLogger(logDir);

registerIpc(manager, logger, () => win?.webContents ?? null);

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#1e1e1e',
    title: 'myterminal',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win?.show());

  const search = SMOKE ? 'smoke=1' : '';
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(search ? `${devUrl}?${search}` : devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search });
  }

  if (SMOKE) runSmoke(win);
}

/** 冒煙測試：等 renderer 自動開好 PowerShell，截圖後結束。*/
function runSmoke(target: BrowserWindow): void {
  target.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void target.webContents
        .capturePage()
        .then((image) => {
          const out = join(app.getAppPath(), 'test-results');
          mkdirSync(out, { recursive: true });
          writeFileSync(join(out, 'smoke.png'), image.toPNG());
          console.log('[smoke] 已寫出', join(out, 'smoke.png'));
        })
        .catch((err: unknown) => console.error('[smoke] 截圖失敗', err))
        .finally(() => {
          manager.closeAll();
          app.exit(0);
        });
    }, 5000);
  });
}

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  logger.stopAll();
  manager.closeAll();
});
