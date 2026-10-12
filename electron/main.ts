import { app, BrowserWindow, dialog, ipcMain, net, protocol } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseStore, atomicWrite } from "./database";
import { exportBundle, parseImport, tasksCSV, type RestorePreview, type StorageInfo } from "../src/lib/model";
import { localDate } from "../src/lib/dates";

protocol.registerSchemesAsPrivileged([{ scheme: "notelah", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setName("NoteLah");
let window: BrowserWindow | null = null;
let store: DatabaseStore;
let dirty = false;
let closingDialog = false;
let queue: Promise<unknown> = Promise.resolve();
let preview: RestorePreview | null = null;

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);
  queue = result.catch(() => undefined);
  return result;
}

function info(): StorageInfo {
  return { mode: "desktop", location: store.databasePath, backupFolder: store.backupFolder, lastBackup: store.lastBackup, backupError: store.backupError };
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(async () => {
    try {
      const testDirectory = !app.isPackaged && process.env.NOTELAH_TEST_DATA_DIR ? path.resolve(process.env.NOTELAH_TEST_DATA_DIR) : null;
      if (testDirectory && !testDirectory.startsWith(path.resolve(app.getAppPath(), "work") + path.sep)) throw new Error("Test data must stay inside the project's work folder.");
      store = new DatabaseStore(testDirectory ?? path.join(app.getPath("appData"), "NoteLah"));
      const wasm = app.isPackaged ? path.join(process.resourcesPath, "sql-wasm.wasm") : path.join(app.getAppPath(), "node_modules/sql.js/dist/sql-wasm.wasm");
      await store.initialize(wasm);
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
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => { if (!url.startsWith("notelah://app/")) event.preventDefault(); });
      const trusted = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
        if (event.sender !== window?.webContents || !event.senderFrame?.url.startsWith("notelah://app/")) throw new Error("Untrusted request");
      };
      function handle(channel: string, operation: (argument: unknown) => Promise<unknown>) {
        ipcMain.handle(channel, (event, argument) => { trusted(event); return serial(() => operation(argument)); });
      }
      handle("workspace:load", async () => ({ state: store.load(), info: info() }));
      handle("workspace:save", async (state) => { await store.save(state as Parameters<typeof store.save>[0]); return info(); });
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
        await atomicWrite(result.filePath, format === "json" ? JSON.stringify(exportBundle(store.load()), null, 2) : tasksCSV(store.load()));
        return { canceled: false, path: result.filePath };
      });
      handle("workspace:restore-preview", async () => {
        const result = await dialog.showOpenDialog(window!, { title: "Choose a NoteLah backup", properties: ["openFile"], filters: [{ name: "NoteLah backups", extensions: ["sqlite", "json"] }] });
        if (result.canceled || !result.filePaths[0]) return null;
        const file = result.filePaths[0];
        if ((await fs.stat(file)).size > 30 * 1024 * 1024) throw new Error("Choose a backup smaller than 30 MB.");
        const bytes = await fs.readFile(file);
        const state = path.extname(file).toLowerCase() === ".json" ? parseImport(bytes.toString("utf8")) : await store.readBackup(bytes);
        let date: string | null = null;
        if (path.extname(file).toLowerCase() === ".json") date = JSON.parse(bytes.toString("utf8")).exportedAt ?? null;
        else date = (await fs.stat(file)).mtime.toISOString();
        preview = { token: randomUUID(), state, date, fileName: path.basename(file) };
        return preview;
      });
      handle("workspace:restore", async (token) => {
        if (!preview || preview.token !== token) throw new Error("Choose your backup again.");
        await store.backupBeforeRestore();
        await store.save(preview.state); preview = null;
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
app.on("before-quit", () => { if (!dirty) store?.close(); });
