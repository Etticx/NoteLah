import { emptyWorkspace, exportBundle, parseImport, tasksCSV, workspaceSchema, type DesktopAPI, type StorageInfo, type WorkspaceState } from "./model";

declare global { interface Window { notelah?: DesktopAPI } }

const DB_NAME = "notelah-workspace";
const STORE = "workspace";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Local storage couldn't be opened. Check your browser storage settings."));
  });
}

async function readLocal(key: string): Promise<unknown> {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

async function writeLocal(values: [string, unknown][]): Promise<void> {
  const db = await openDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      for (const [key, value] of values) transaction.objectStore(STORE).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("The save was interrupted."));
    });
  } finally { db.close(); }
}

export const browserInfo: StorageInfo = { mode: "browser", location: "This browser on this laptop", backupFolder: null, lastBackup: null };

export async function loadWorkspace(): Promise<{ state: WorkspaceState; info: StorageInfo }> {
  if (window.notelah) return window.notelah.load();
  const stored = await readLocal("state");
  const state = stored === undefined ? emptyWorkspace() : workspaceSchema.parse(stored);
  if (state.notes.some((note) => note.file)) throw new Error("This library contains imported files. Open it in the Windows app.");
  return { state, info: { ...browserInfo, lastBackup: (await readLocal("lastBackup") as string | undefined) ?? null } };
}

export async function saveWorkspace(state: WorkspaceState): Promise<StorageInfo> {
  const validated = workspaceSchema.parse(state);
  if (window.notelah) return window.notelah.save(validated);
  if (validated.notes.some((note) => note.file)) throw new Error("Imported files are available in the Windows app.");
  const day = new Date().toLocaleDateString("en-CA");
  const lastDay = await readLocal("backupDay");
  const entries: [string, unknown][] = [["state", validated]];
  if (validated.settings.automaticBackups && day !== lastDay) {
    const existing = await readLocal("state");
    if (existing) {
      const backups = ((await readLocal("backups")) as unknown[] | undefined) ?? [];
      entries.push(["backups", [...backups.slice(-6), { savedAt: new Date().toISOString(), state: existing }]], ["backupDay", day], ["lastBackup", new Date().toISOString()]);
    }
  }
  await writeLocal(entries);
  return { ...browserInfo, lastBackup: (await readLocal("lastBackup") as string | undefined) ?? null };
}

export function downloadFile(content: string, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportWorkspace(state: WorkspaceState, format: "json" | "csv") {
  if (window.notelah) return window.notelah.exportData(format);
  const name = `NoteLah-${new Date().toISOString().slice(0, 10)}.${format}`;
  downloadFile(format === "json" ? JSON.stringify(exportBundle(state), null, 2) : tasksCSV(state), name, format === "json" ? "application/json" : "text/csv;charset=utf-8");
  return { canceled: false, path: name };
}

export async function backupWorkspace(state: WorkspaceState) {
  if (window.notelah) return window.notelah.backup();
  const result = await exportWorkspace(state, "json");
  await writeLocal([["lastBackup", new Date().toISOString()]]);
  return result;
}

export async function importBrowserFile(file: File): Promise<WorkspaceState> {
  if (file.size > 30 * 1024 * 1024) throw new Error("Choose a backup smaller than 30 MB.");
  const state = parseImport(await file.text());
  if (state.notes.some((note) => note.file)) throw new Error("This backup includes imported files. Restore it in the Windows app so the files are preserved.");
  return state;
}

export async function restoreBrowser(state: WorkspaceState): Promise<void> {
  if (state.notes.some((note) => note.file)) throw new Error("Restore backups containing imported files in the Windows app.");
  const current = await readLocal("state");
  if (current) downloadFile(JSON.stringify(exportBundle(workspaceSchema.parse(current)), null, 2), `NoteLah-before-restore-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`, "application/json");
  await writeLocal([["beforeRestore", { savedAt: new Date().toISOString(), state: current }], ["state", workspaceSchema.parse(state)]]);
}
