import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type { MyTerminalApi } from '../shared/api';

/**
 * 唯一的信任邊界：renderer 只看得到這份白名單 API，
 * 拿不到 ipcRenderer 也拿不到 Node。
 */
const api: MyTerminalApi = {
  createSession: (profile, cols, rows) =>
    ipcRenderer.invoke(IPC.createSession, { profile, cols, rows }),
  write: (id, data) => ipcRenderer.invoke(IPC.write, { id, data }),
  resize: (id, cols, rows) => ipcRenderer.invoke(IPC.resize, { id, cols, rows }),
  close: (id) => ipcRenderer.invoke(IPC.close, id),
  list: () => ipcRenderer.invoke(IPC.list),
  startLog: (id) => ipcRenderer.invoke(IPC.startLog, id),
  stopLog: (id) => ipcRenderer.invoke(IPC.stopLog, id),

  onData: (listener) => void ipcRenderer.on(IPC.data, (_e, payload) => listener(payload)),
  onExit: (listener) => void ipcRenderer.on(IPC.exit, (_e, payload) => listener(payload)),
  onSessionsChanged: (listener) =>
    void ipcRenderer.on(IPC.sessionsChanged, (_e, payload) => listener(payload)),
};

contextBridge.exposeInMainWorld('myterminal', api);
