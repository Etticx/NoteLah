import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopAPI } from "../src/lib/model";

const api: DesktopAPI = {
  agentPlan: (request) => ipcRenderer.invoke("agent:plan", request),
  agentApply: (token) => ipcRenderer.invoke("agent:apply", token),
  agentUndo: (token) => ipcRenderer.invoke("agent:undo", token),
  chatModels: () => ipcRenderer.invoke("chat:models"),
  chatAsk: (request) => ipcRenderer.invoke("chat:ask", request),
  chatStatus: () => ipcRenderer.invoke("chat:status"),
  chatCancel: () => ipcRenderer.invoke("chat:cancel"),
  chatResetIndex: () => ipcRenderer.invoke("chat:reset-index"),
  chatSource: (noteId) => ipcRenderer.invoke("chat:source", noteId),
  load: () => ipcRenderer.invoke("workspace:load"),
  save: (state) => ipcRenderer.invoke("workspace:save", state),
  setDirty: (value) => ipcRenderer.send("workspace:dirty", value),
  backup: () => ipcRenderer.invoke("workspace:backup"),
  chooseBackupFolder: () => ipcRenderer.invoke("workspace:backup-folder"),
  exportData: (format) => ipcRenderer.invoke("workspace:export", format),
  selectRestore: () => ipcRenderer.invoke("workspace:restore-preview"),
  restore: (token) => ipcRenderer.invoke("workspace:restore", token),
  importNotes: (folderId) => ipcRenderer.invoke("notes:import", folderId),
  importDroppedNotes: async (folderId, files) => {
    const paths = files.map((file) => webUtils.getPathForFile(file));
    if (!paths.length || paths.some((file) => !file)) throw new Error("Drop files directly from File Explorer.");
    return ipcRenderer.invoke("notes:import-dropped", { folderId, paths });
  },
  openNoteFile: (noteId) => ipcRenderer.invoke("notes:open-file", noteId),
  openNotesFolder: () => ipcRenderer.invoke("notes:open-folder"),
};

contextBridge.exposeInMainWorld("notelah", api);
