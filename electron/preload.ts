import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI } from "../src/lib/model";

const api: DesktopAPI = {
  load: () => ipcRenderer.invoke("workspace:load"),
  save: (state) => ipcRenderer.invoke("workspace:save", state),
  setDirty: (value) => ipcRenderer.send("workspace:dirty", value),
  backup: () => ipcRenderer.invoke("workspace:backup"),
  chooseBackupFolder: () => ipcRenderer.invoke("workspace:backup-folder"),
  exportData: (format) => ipcRenderer.invoke("workspace:export", format),
  selectRestore: () => ipcRenderer.invoke("workspace:restore-preview"),
  restore: (token) => ipcRenderer.invoke("workspace:restore", token),
  importNotes: (folderId) => ipcRenderer.invoke("notes:import", folderId),
  openNoteFile: (noteId) => ipcRenderer.invoke("notes:open-file", noteId),
  openNotesFolder: () => ipcRenderer.invoke("notes:open-folder"),
};

contextBridge.exposeInMainWorld("notelah", api);
