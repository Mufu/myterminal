import { dialog, ipcMain, type WebContents } from 'electron';
import { IPC } from '../shared/ipc';
import type {
  CreateSessionRequest,
  WriteRequest,
  ResizeRequest,
  ResumeWorkflowRequest,
  SaveCliSettingRequest,
  SetRolesDirRequest,
  StartWorkflowRequest,
} from '../shared/ipc';
import type { SavedProfile } from '../shared/profile';
import type { CliId } from '../shared/cli-auth';
import { loginProfile, validateCliSetting } from '../shared/cli-auth';
import type { WorkflowDefinition } from '../shared/workflow';
import { validateRunParams } from '../shared/workflow';
import type { SessionManager } from './session-manager';
import type { SessionLogger } from './session-logger';
import type { ProfileStore } from './profile-store';
import type { CliAuthBridge } from './cli-auth-bridge';
import type { RoleService } from './role-library';
import type { WorkflowService } from './workflow/workflow-service';
import type { WorkflowStore } from './workflow/workflow-store';
import { findWorkflow, listWorkflows } from './workflow/catalog';

/** 登入用的工作階段開出來時還沒有終端機，先給一個尺寸，show() 時會量過重設。*/
const LOGIN_COLS = 120;
const LOGIN_ROWS = 30;

/**
 * IPC 橋接層：刻意保持很薄。
 * 只做「頻道 -> SessionManager / SessionLogger 方法」的轉接，
 * 以及把 SessionManager 的事件推給 renderer；沒有任何商業邏輯。
 */
export function registerIpc(
  manager: SessionManager,
  logger: SessionLogger,
  profiles: ProfileStore,
  workflows: WorkflowService,
  definitions: WorkflowStore,
  cli: CliAuthBridge,
  roles: RoleService,
  getWebContents: () => WebContents | null,
): void {
  const send = (channel: string, payload: unknown): void => {
    getWebContents()?.send(channel, payload);
  };
  const pushSessions = (): void => send(IPC.sessionsChanged, manager.list());
  const pushProfiles = (): void => send(IPC.profilesChanged, profiles.list());

  /** 正在跑登入流程的工作階段；結束時要重探登入狀態。*/
  const loginSessions = new Set<string>();

  // main -> renderer
  manager.on('data', (event) => {
    logger.write(event.id, event.data);
    send(IPC.data, event);
  });
  manager.on('exit', (event) => {
    send(IPC.exit, event);
    pushSessions();
    // 使用者在那個工作階段裡把登入走完了，晶片上的字要跟著換。
    if (loginSessions.delete(event.id)) {
      void cli.refresh().then((status) => send(IPC.cliAuthChanged, status));
    }
  });
  manager.on('created', pushSessions);
  manager.on('updated', pushSessions);
  manager.on('closed', pushSessions);
  workflows.on('changed', (runs) => send(IPC.workflowChanged, runs));

  // renderer -> main
  ipcMain.handle(IPC.createSession, (_e, req: CreateSessionRequest) =>
    manager.create(req.profile, req.cols, req.rows),
  );
  ipcMain.handle(IPC.write, (_e, req: WriteRequest) => manager.write(req.id, req.data));
  ipcMain.handle(IPC.resize, (_e, req: ResizeRequest) =>
    manager.resize(req.id, req.cols, req.rows),
  );
  ipcMain.handle(IPC.close, (_e, id: string) => {
    logger.stop(id);
    manager.close(id);
  });
  ipcMain.handle(IPC.list, () => manager.list());

  ipcMain.handle(IPC.startLog, (_e, id: string) => {
    const session = manager.list().find((s) => s.id === id);
    if (!session) throw new Error(`找不到工作階段 ${id}`);
    const path = logger.start(id, session.name);
    manager.setLogging(id, true);
    pushSessions();
    return path;
  });

  ipcMain.handle(IPC.stopLog, (_e, id: string) => {
    logger.stop(id);
    manager.setLogging(id, false);
    pushSessions();
  });

  ipcMain.handle(IPC.listProfiles, () => profiles.list());

  ipcMain.handle(IPC.saveProfile, (_e, profile: SavedProfile) => {
    profiles.save(profile);
    pushProfiles();
  });

  ipcMain.handle(IPC.removeProfile, (_e, name: string) => {
    profiles.remove(name);
    pushProfiles();
  });

  ipcMain.handle(IPC.listWorkflows, () => listWorkflows(definitions));
  ipcMain.handle(IPC.getWorkflow, (_e, id: string) => findWorkflow(id, definitions));
  ipcMain.handle(IPC.saveWorkflow, (_e, definition: WorkflowDefinition) =>
    definitions.save(definition),
  );
  ipcMain.handle(IPC.deleteWorkflow, (_e, id: string) => definitions.remove(id));

  ipcMain.handle(IPC.startWorkflow, (_e, req: StartWorkflowRequest) => {
    const definition = findWorkflow(req.workflowId, definitions);
    if (!definition) throw new Error(`找不到工作流 ${req.workflowId}`);
    // 對話框已經擋過一次，這裡是 IPC 這一側的保險 (每行一條，跟存檔時一樣)。
    const errors = validateRunParams(definition, req.params);
    if (errors.length > 0) throw new Error(errors.join('\n'));
    return workflows.start(definition, req.params, { maxTotalCostUsd: req.maxTotalCostUsd });
  });

  ipcMain.handle(IPC.resumeWorkflow, (_e, req: ResumeWorkflowRequest) =>
    workflows.resume(req.runId, { approved: req.approved }),
  );
  ipcMain.handle(IPC.cancelWorkflow, (_e, runId: string) => workflows.cancel(runId));
  ipcMain.handle(IPC.workflowRuns, () => workflows.list());
  // 探測是視窗出來之後才開始的，這裡等的是同一個 Promise。
  ipcMain.handle(IPC.cliAuth, () => cli.status());

  // 「重新偵測」：在外面的終端機登入 / 登出之後不必重開 app。
  // 別的地方 (例如畫布) 也在看晶片，所以重探完一樣推一次。
  ipcMain.handle(IPC.cliRefresh, async () => {
    const status = await cli.refresh();
    send(IPC.cliAuthChanged, status);
    return status;
  });

  ipcMain.handle(IPC.cliSettings, () => cli.store.settings());

  ipcMain.handle(IPC.saveCliSetting, (_e, req: SaveCliSettingRequest) => {
    // 跟連線設定一樣：renderer 先驗一次，main 這邊仍然是最後一道。
    const errors = validateCliSetting(req, cli.store.get(req.id).hasKey);
    if (errors.length > 0) throw new Error(errors.join('\n'));
    cli.store.set(req.id, req);
    return cli.store.settings();
  });

  ipcMain.handle(IPC.clearCliKey, (_e, id: CliId) => {
    cli.store.clearKey(id);
    return cli.store.settings();
  });

  // 角色庫：清單、重新掃描、換資料夾。三個都回同一種結果，
  // renderer 那邊就只有一條「拿到新的角色清單」的路徑。
  ipcMain.handle(IPC.rolesList, () => roles.list());
  ipcMain.handle(IPC.rolesRescan, () => roles.rescan());
  ipcMain.handle(IPC.rolesSetDir, (_e, req: SetRolesDirRequest) => roles.setDir(req.dir));

  // 「瀏覽…」：原生的選資料夾對話框，取消就回 null (畫面上什麼都不動)。
  ipcMain.handle(IPC.rolesPickDir, async () => {
    const result = await dialog.showOpenDialog({
      title: '選擇角色資料夾',
      defaultPath: roles.dir(),
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.cliLogin, (_e, id: CliId) => {
    // 就是一個普通的工作階段：出現在清單裡，使用者自己在裡面把瀏覽器流程走完。
    const session = manager.create(loginProfile(id), LOGIN_COLS, LOGIN_ROWS);
    loginSessions.add(session.id);
    return session.id;
  });
}
