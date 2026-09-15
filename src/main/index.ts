import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { SessionManager } from './session-manager';
import { SessionLogger, defaultLogDir, ensureLogDir } from './session-logger';
import { NodePtySpawner } from './node-pty-spawner';
import { ShellFactory } from './shell-factory';
import { fileProfileStore } from './profile-store';
import { defaultAgentRunners } from './agent-runner';
import { NodeProcessSpawner } from './process-spawner';
import { probeCliAuth } from './cli-auth-probe';
import { fileCliAuthStore } from './cli-auth-store';
import { safeStorageCipher } from './safe-storage-cipher';
import { cliSecrets } from './cli-secrets';
import type { AgentKind } from '../shared/agent';
import type { BillingMode, CliAuthStatus } from '../shared/cli-auth';
import { fileCheckpointSaver } from './workflow/json-file-saver';
import { WorkflowService, fileRunStore } from './workflow/workflow-service';
import { fileWorkflowStore } from './workflow/workflow-store';
import { registerIpc } from './ipc';

let win: BrowserWindow | null = null;

// 最後一道防線：主行程的未捕捉例外預設會跳出錯誤對話框，改成寫進 stderr。
process.on('uncaughtException', (error) => console.error('[main] 未捕捉的例外', error));

// 紀錄檔的目錄；e2e 用 MYTERMINAL_LOG_DIR 指到自己的暫存目錄，不去碰使用者的。
const logDir = process.env.MYTERMINAL_LOG_DIR?.trim() || defaultLogDir();
ensureLogDir(logDir);

// 「CLI 設定」：使用者為每支 CLI 選的登入方式與 (加密後的) API 金鑰。
const cliStore = fileCliAuthStore(join(app.getPath('userData'), 'cli-auth.json'), safeStorageCipher());

// CLI 是用訂閱還是 API 金鑰登入：開機問一次就好，不擋啟動 (探測不出來也照跑)。
// 金額要不要標成估算看它，所以 agent 的結果行與 renderer 都拿同一份結果。
const probe = (): Promise<CliAuthStatus> =>
  probeCliAuth(new NodeProcessSpawner(), (id) => cliStore.get(id).hasKey);
let cliAuth = probe();
let auth: CliAuthStatus | null = null;
const remember = (status: CliAuthStatus): CliAuthStatus => (auth = status);
void cliAuth.then(remember);
const billingMode = (kind: AgentKind): BillingMode => auth?.[kind].mode ?? 'unknown';

// 組裝：正式環境注入真的 node-pty spawner 與真的檔案 sink。
// ShellFactory 多拿一條金鑰縫線，選了 API 金鑰的 CLI 才會被注入環境變數。
const manager = new SessionManager(
  new NodePtySpawner(),
  new ShellFactory(undefined, cliSecrets(cliStore)),
  undefined,
  undefined,
  billingMode,
);
const logger = new SessionLogger(logDir);
const profiles = fileProfileStore(join(app.getPath('userData'), 'profiles.json'));

// 工作流：圖的 checkpoint 一個執行一個檔，清單摘要則是一份 JSON。
// 節點的 CLI 執行透過 SessionManager.adoptAgentRun 變成畫面上的工作階段。
const workflows = new WorkflowService({
  runnerFactory: defaultAgentRunners,
  sessions: manager,
  checkpointer: fileCheckpointSaver(join(app.getPath('userData'), 'workflow-runs')),
  ...fileRunStore(join(app.getPath('userData'), 'workflow-runs.json')),
});

// 自訂工作流的定義：畫布存進去、執行的時候從這裡找。
const workflowDefinitions = fileWorkflowStore(join(app.getPath('userData'), 'workflows.json'));

// 關窗之後 pty 的 exit 事件才可能送達，那時 webContents 已經被銷毀。
registerIpc(
  manager,
  logger,
  profiles,
  workflows,
  workflowDefinitions,
  {
    status: () => cliAuth,
    // 登入流程跑完之後重探一次，之後問到的就是新的結果。
    refresh: () => (cliAuth = probe().then(remember)),
    store: cliStore,
  },
  () => (win && !win.isDestroyed() ? win.webContents : null),
);

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    // 再小工具列右邊的按鈕就被擠出畫面外，而且沒有捲軸可以捲過去。
    minWidth: 900,
    minHeight: 560,
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
