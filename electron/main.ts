import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { z } from "zod";
import { mkdirSync, promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseStore, atomicWrite } from "./database";
import { MAX_BACKUP_BYTES, tasksCSV, type RestorePreview, type StorageInfo } from "../src/lib/model";
import type { FileContents } from "./library";
import { localDate } from "../src/lib/dates";
import { RagService, ragRequestSchema } from "./rag";

protocol.registerSchemesAsPrivileged([{ scheme: "notelah", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setName("NoteLah");
const appId = "local.notelah.desktop";
if (process.platform === "win32") app.setAppUserModelId(appId);
const testDirectory = !app.isPackaged && process.env.NOTELAH_TEST_DATA_DIR ? path.resolve(process.env.NOTELAH_TEST_DATA_DIR) : null;
if (testDirectory) {
  if (!testDirectory.startsWith(path.resolve(app.getAppPath(), "work") + path.sep)) throw new Error("Test data must stay inside the project's work folder.");
  mkdirSync(testDirectory, { recursive: true });
  app.setPath("userData", testDirectory);
}
let window: BrowserWindow | null = null;
let store: DatabaseStore;
let rag: RagService;
let dirty = false;
let closingDialog = false;
let queue: Promise<unknown> = Promise.resolve();
let preview: RestorePreview | null = null;
let previewFiles: FileContents = new Map();

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);
  queue = result.catch(() => undefined);
  return result;
}

function info(): StorageInfo {
  return { mode: "desktop", location: store.databasePath, backupFolder: store.backupFolder, lastBackup: store.lastBackup, backupError: store.backupError, filesLocation: store.library.directory, filesBytes: store.filesBytes };
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(async () => {
    try {
      store = new DatabaseStore(testDirectory ?? path.join(app.getPath("appData"), "NoteLah"));
      const wasm = app.isPackaged ? path.join(process.resourcesPath, "sql-wasm.wasm") : path.join(app.getAppPath(), "node_modules/sql.js/dist/sql-wasm.wasm");
      await store.initialize(wasm);
      rag = new RagService(store);
      await rag.initialize(wasm);
      const output = path.join(app.getAppPath(), "out");
      protocol.handle("notelah", async (request) => {
        const url = new URL(request.url);
        if (url.hostname !== "app") return new Response("Not found", { status: 404 });
        let file = path.resolve(output, `.${decodeURIComponent(url.pathname)}`);
        if (url.pathname.endsWith("/")) file = path.join(file, "index.html");
        const relative = path.relative(output, file);
        if (relative.startsWith("..") || path.isAbsolute(relative)) return new Response("Not found", { status: 404 });
        const response = await net.fetch(pathToFileURL(file).toString());
        const headers = new Headers(response.headers);
        headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'");
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      });
      window = new BrowserWindow({ width: 1240, height: 850, minWidth: 850, minHeight: 620, title: "NoteLah", icon: path.join(app.getAppPath(), "assets/icon.png"), backgroundColor: "#ffffff", autoHideMenuBar: true, show: false, webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      if (process.platform === "win32" && app.isPackaged) {
        // Portable builds run from a temporary folder that is removed on exit.
        const launcher = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
        window.setAppDetails({ appId, appIconPath: launcher, appIconIndex: 0, relaunchCommand: `"${launcher}"`, relaunchDisplayName: "NoteLah" });
      }
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => { if (!url.startsWith("notelah://app/")) event.preventDefault(); });
      const trusted = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
        if (event.sender !== window?.webContents || !event.senderFrame?.url.startsWith("notelah://app/")) throw new Error("Untrusted request");
      };
      function handle(channel: string, operation: (argument: unknown) => Promise<unknown>) {
        ipcMain.handle(channel, (event, argument) => { trusted(event); return serial(() => operation(argument)); });
      }
      // Long inference jobs must not block workspace saves or cancellation.
      ipcMain.handle("chat:models", (event) => { trusted(event); return rag.models(); });
      ipcMain.handle("chat:ask", async (event, argument) => { trusted(event); const request = ragRequestSchema.parse(argument); await queue; return rag.ask(request); });
      ipcMain.handle("chat:status", (event) => { trusted(event); return rag.status; });
      ipcMain.handle("chat:cancel", (event) => { trusted(event); rag.cancel(); });
      ipcMain.handle("chat:reset-index", (event) => { trusted(event); return rag.rebuild(); });
      handle("chat:source", async (argument) => {
        const note = store.load().notes.find((note) => note.id === z.string().uuid().parse(argument));
        if (!note) throw new Error("This source was deleted. Ask again to search your current notes.");
        return note;
      });
      handle("workspace:load", async () => ({ state: store.load(), info: info() }));
      handle("workspace:save", async (state) => { await store.save(state as Parameters<typeof store.save>[0]); return info(); });
      handle("notes:import", async (argument) => {
        const folderId = z.string().uuid().nullable().parse(argument);
        const result = await dialog.showOpenDialog(window!, { title: "Import into Notes", properties: ["openFile", "multiSelections"], filters: [{ name: "Notes and documents", extensions: ["txt", "md", "pdf"] }] });
        if (result.canceled || !result.filePaths.length) return null;
        const state = await store.importFiles(result.filePaths, folderId);
        return { state, info: info() };
      });
      handle("notes:import-dropped", async (argument) => {
        const { folderId, paths } = z.object({ folderId: z.string().uuid().nullable(), paths: z.array(z.string().refine((file) => path.isAbsolute(file))).min(1).max(10) }).parse(argument);
        const state = await store.importFiles(paths, folderId);
        return { state, info: info() };
      });
      handle("notes:open-file", async (argument) => {
        const id = z.string().uuid().parse(argument);
        const note = store.load().notes.find((note) => note.id === id);
        if (!note?.file) throw new Error("Choose an imported file.");
        await store.library.read(note.file);
        const error = await shell.openPath(store.library.location(note.file));
        if (error) throw new Error(error);
      });
      handle("notes:open-folder", async () => {
        await fs.mkdir(store.library.directory, { recursive: true });
        const error = await shell.openPath(store.library.directory);
        if (error) throw new Error(error);
      });
      ipcMain.on("workspace:dirty", (event, value) => { trusted(event); dirty = value === true; });
      handle("workspace:backup", async () => {
        const result = await dialog.showSaveDialog(window!, { title: "Back up NoteLah", defaultPath: path.join(store.backupFolder, `NoteLah-${localDate()}.sqlite`), filters: [{ name: "NoteLah SQLite backup", extensions: ["sqlite"] }] });
        if (result.canceled || !result.filePath) return { canceled: true };
        await store.backup(result.filePath);
        return { canceled: false, path: result.filePath };
      });
      handle("workspace:backup-folder", async () => {
        const result = await dialog.showOpenDialog(window!, { title: "Choose your automatic backup folder", defaultPath: store.backupFolder, properties: ["openDirectory", "createDirectory"] });
        if (result.canceled || !result.filePaths[0]) return null;
        await store.chooseFolder(result.filePaths[0]); return info();
      });
      handle("workspace:export", async (format) => {
        if (format !== "json" && format !== "csv") throw new Error("Unsupported export format");
        const result = await dialog.showSaveDialog(window!, { title: "Export NoteLah", defaultPath: `NoteLah-${localDate()}.${format}`, filters: [{ name: format === "json" ? "NoteLah JSON export" : "Spreadsheet CSV", extensions: [format] }] });
        if (result.canceled || !result.filePath) return { canceled: true };
        if (path.resolve(result.filePath).toLowerCase() === path.resolve(store.databasePath).toLowerCase()) throw new Error("Choose a different file from your active database.");
        if (path.resolve(result.filePath).toLowerCase().startsWith(path.resolve(store.library.directory).toLowerCase() + path.sep)) throw new Error("Choose an export location outside the imported files folder.");
        await atomicWrite(result.filePath, format === "json" ? await store.exportJSON() : tasksCSV(store.load()));
        return { canceled: false, path: result.filePath };
      });
      handle("workspace:restore-preview", async () => {
        const result = await dialog.showOpenDialog(window!, { title: "Choose a NoteLah backup", properties: ["openFile"], filters: [{ name: "NoteLah backups", extensions: ["sqlite", "json"] }] });
        if (result.canceled || !result.filePaths[0]) return null;
        const file = result.filePaths[0];
        if ((await fs.stat(file)).size > MAX_BACKUP_BYTES) throw new Error("Choose a backup smaller than 100 MB.");
        const bytes = await fs.readFile(file);
        const decoded = path.extname(file).toLowerCase() === ".json" ? store.decodeJSON(bytes.toString("utf8")) : await store.decodeBackup(bytes);
        const state = decoded.state;
        let date: string | null = null;
        if (path.extname(file).toLowerCase() === ".json") date = JSON.parse(bytes.toString("utf8")).exportedAt ?? null;
        else date = (await fs.stat(file)).mtime.toISOString();
        preview = { token: randomUUID(), state, date, fileName: path.basename(file) };
        previewFiles = decoded.files;
        return preview;
      });
      handle("workspace:restore", async (token) => {
        if (!preview || preview.token !== token) throw new Error("Choose your backup again.");
        await store.backupBeforeRestore();
        await store.restore(preview.state, previewFiles); preview = null; previewFiles = new Map();
        return { state: store.load(), info: info() };
      });
      window.on("close", (event) => {
        if (!dirty) return;
        event.preventDefault();
        if (closingDialog) return;
        closingDialog = true;
        dialog.showMessageBox(window!, { type: "warning", title: "Changes aren't saved yet", message: "Keep NoteLah open until your changes are saved.", buttons: ["Keep open", "Close without saving"], defaultId: 0, cancelId: 0 }).then(({ response }) => { closingDialog = false; if (response === 1) { dirty = false; window?.close(); } });
      });
      window.once("ready-to-show", () => window?.show());
      await window.loadURL("notelah://app/");
    } catch (error) {
      dialog.showErrorBox("NoteLah couldn't open", `${(error as Error).message}\n\nYour existing data has not been deleted.`); app.quit();
    }
  });
}
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { if (!dirty) { rag?.cancel(); store?.close(); } });
