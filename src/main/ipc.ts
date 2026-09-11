import { ipcMain, type WebContents } from 'electron';
import { IPC } from '../shared/ipc';
import type {
  CreateSessionRequest,
  WriteRequest,
  ResizeRequest,
  ResumeWorkflowRequest,
  StartWorkflowRequest,
} from '../shared/ipc';
import type { SavedProfile } from '../shared/profile';
import type { SessionManager } from './session-manager';
import type { SessionLogger } from './session-logger';
import type { ProfileStore } from './profile-store';
import type { WorkflowService } from './workflow/workflow-service';
import { findTemplate, templateInfos } from './workflow/templates';

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
  getWebContents: () => WebContents | null,
): void {
  const send = (channel: string, payload: unknown): void => {
    getWebContents()?.send(channel, payload);
  };
  const pushSessions = (): void => send(IPC.sessionsChanged, manager.list());
  const pushProfiles = (): void => send(IPC.profilesChanged, profiles.list());

  // main -> renderer
  manager.on('data', (event) => {
    logger.write(event.id, event.data);
    send(IPC.data, event);
  });
  manager.on('exit', (event) => {
    send(IPC.exit, event);
    pushSessions();
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

  ipcMain.handle(IPC.workflowTemplates, () => templateInfos());

  ipcMain.handle(IPC.startWorkflow, (_e, req: StartWorkflowRequest) => {
    const definition = findTemplate(req.templateId);
    if (!definition) throw new Error(`找不到工作流範本 ${req.templateId}`);
    return workflows.start(definition, req.params);
  });

  ipcMain.handle(IPC.resumeWorkflow, (_e, req: ResumeWorkflowRequest) =>
    workflows.resume(req.runId, { approved: req.approved }),
  );
  ipcMain.handle(IPC.cancelWorkflow, (_e, runId: string) => workflows.cancel(runId));
  ipcMain.handle(IPC.workflowRuns, () => workflows.list());
}
