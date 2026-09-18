import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { SessionManager } from './session-manager';
import { SessionLogger, defaultLogDir, ensureLogDir } from './session-logger';
import { NodePtySpawner } from './node-pty-spawner';
import { ShellFactory } from './shell-factory';
import { fileProfileStore } from './profile-store';
import { fileSettingsStore } from './settings-store';
import { RoleService, fileRoleLibrary } from './role-library';
import { agentRunners } from './agent-runner';
import { AssistantService } from './assistant-service';
import { NodeProcessSpawner } from './process-spawner';
import { probeCliAuth } from './cli-auth-probe';
import { cliAuthBridge } from './cli-auth-bridge';
import { fileCliAuthStore } from './cli-auth-store';
import { safeStorageCipher } from './safe-storage-cipher';
import { cliSecrets } from './cli-secrets';
import type { AgentKind } from '../shared/agent';
import type { BillingMode } from '../shared/cli-auth';
import { WorkflowService, fileRunStore, lazyCheckpointSaver } from './workflow/workflow-service';
import { fileWorkflowStore } from './workflow/workflow-store';
import { registerIpc } from './ipc';

let win: BrowserWindow | null = null;

/** 視窗出來之後隔多久才探四支 CLI 的登入狀態 (讓第一個畫面先畫完)。*/
const PROBE_DELAY_MS = 300;

// 最後一道防線：主行程的未捕捉例外預設會跳出錯誤對話框，改成寫進 stderr。
process.on('uncaughtException', (error) => console.error('[main] 未捕捉的例外', error));

// 紀錄檔的目錄；e2e 用 MYTERMINAL_LOG_DIR 指到自己的暫存目錄，不去碰使用者的。
const logDir = process.env.MYTERMINAL_LOG_DIR?.trim() || defaultLogDir();
ensureLogDir(logDir);

// 「CLI 設定」：使用者為每支 CLI 選的登入方式與 (加密後的) API 金鑰。
const cliStore = fileCliAuthStore(join(app.getPath('userData'), 'cli-auth.json'), safeStorageCipher());

// CLI 是用訂閱還是 API 金鑰登入：開機問一次就好，不擋啟動 (探測不出來也照跑)。
// 金額要不要標成估算看它，所以 agent 的結果行與 renderer 都拿同一份結果；
// 使用者按「重新偵測」或跑完登入流程時會重探，探測中再按也只會探一輪。
// 開機那一輪是視窗出來之後才開始的，見 createWindow。
const cli = cliAuthBridge(
  () => probeCliAuth(new NodeProcessSpawner(), (id) => cliStore.get(id).hasKey),
  cliStore,
);
const billingMode = (kind: AgentKind): BillingMode => cli.latest()?.[kind].mode ?? 'unknown';

// 組裝：正式環境注入真的 node-pty spawner 與真的檔案 sink。
// ShellFactory 與 agent runner 共用同一條金鑰縫線，所以選了 API 金鑰的 CLI
// 在互動式工作階段、Agent 任務、工作流節點三邊都拿得到金鑰。
// 角色庫：使用者指一個資料夾 (預設 userData/roles)，裡面的 markdown 就是角色。
// 一開機不掃 —— 第一次有人問 (renderer 的 roles:list) 才走那一趟磁碟。
const roles = new RoleService(
  fileRoleLibrary(),
  fileSettingsStore(join(app.getPath('userData'), 'settings.json')),
  join(app.getPath('userData'), 'roles'),
);

const secrets = cliSecrets(cliStore);
const runners = agentRunners(secrets);
const manager = new SessionManager(
  new NodePtySpawner(),
  new ShellFactory(undefined, secrets),
  undefined,
  runners,
  billingMode,
  undefined,
  roles.registry,
);
const logger = new SessionLogger(logDir);
const profiles = fileProfileStore(join(app.getPath('userData'), 'profiles.json'));

// 工作流：圖的 checkpoint 一個執行一個檔，清單摘要則是一份 JSON。
// 節點的 CLI 執行透過 SessionManager.adoptAgentRun 變成畫面上的工作階段。
const workflows = new WorkflowService({
  runnerFactory: runners,
  sessions: manager,
  checkpointer: lazyCheckpointSaver(join(app.getPath('userData'), 'workflow-runs')),
  roles: roles.registry,
  ...fileRunStore(join(app.getPath('userData'), 'workflow-runs.json')),
});

// 自訂工作流的定義：畫布存進去、執行的時候從這裡找。
const workflowDefinitions = fileWorkflowStore(
  join(app.getPath('userData'), 'workflows.json'),
  roles.registry,
);

// 「助理」：知識檔開發時就在 repo 裡，打包版由 electron-builder 的 extraResources
// 放到 resources/ASSISTANT.md。選了 API 金鑰時 CLI 就是拿那把金鑰在跑，
// 所以「登入了沒有」跟晶片上的字看的是同一件事。
const assistant = new AssistantService(new NodeProcessSpawner(), {
  knowledgePath: app.isPackaged
    ? join(process.resourcesPath, 'ASSISTANT.md')
    : join(__dirname, '../../docs/ASSISTANT.md'),
  isClaudeLoggedIn: () => {
    const setting = cliStore.get('claude');
    if (setting.mode === 'apiKey' && setting.hasKey) return true;
    return cli.latest()?.claude.loggedIn ?? false;
  },
});

// 關窗之後 pty 的 exit 事件才可能送達，那時 webContents 已經被銷毀。
registerIpc(
  manager,
  logger,
  profiles,
  workflows,
  workflowDefinitions,
  cli,
  roles,
  assistant,
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

  win.once('ready-to-show', () => {
    win?.show();
    // 探測是四個 Node 行程，跟 Electron 自己的啟動搶 CPU 會讓第一個視窗晚一秒多
    // 才出現，所以等視窗畫出來再探。晶片上先寫「偵測中…」，探完才換成結果。
    setTimeout(() => void cli.refresh(), PROBE_DELAY_MS);
  });
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
