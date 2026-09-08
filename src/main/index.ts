import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { SessionManager } from './session-manager';
import { SessionLogger, defaultLogDir, ensureLogDir } from './session-logger';
import { NodePtySpawner } from './node-pty-spawner';
import { ShellFactory } from './shell-factory';
import { registerIpc } from './ipc';

let win: BrowserWindow | null = null;

// 最後一道防線：主行程的未捕捉例外預設會跳出錯誤對話框，改成寫進 stderr。
process.on('uncaughtException', (error) => console.error('[main] 未捕捉的例外', error));

const logDir = defaultLogDir();
ensureLogDir(logDir);

// 組裝：正式環境注入真的 node-pty spawner 與真的檔案 sink。
const manager = new SessionManager(new NodePtySpawner(), new ShellFactory());
const logger = new SessionLogger(logDir);

// 關窗之後 pty 的 exit 事件才可能送達，那時 webContents 已經被銷毀。
registerIpc(manager, logger, () => (win && !win.isDestroyed() ? win.webContents : null));

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#111417',
    title: 'myterminal',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => (win = null));

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
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
