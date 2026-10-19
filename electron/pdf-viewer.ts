import { BrowserWindow } from "electron";
import { pathToFileURL } from "node:url";

// Open only paths already verified by the managed library. No app preload or IPC
// bridge is given to the document viewer, and external navigation is disabled.
export class PdfViewer {
  private readonly windows = new Map<string, BrowserWindow>();
  async open(file: string, title: string, parent: BrowserWindow) {
    const existing = this.windows.get(file);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show(); existing.focus(); return;
    }
    const url = pathToFileURL(file).href;
    const viewer = new BrowserWindow({ parent, width: 1000, height: 850, minWidth: 600, minHeight: 450, title: `${title} — NoteLah`, show: false, autoHideMenuBar: true, backgroundColor: "#525659", webPreferences: { plugins: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "notelah-pdf-viewer" } });
    this.windows.set(file, viewer);
    viewer.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    viewer.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    viewer.webContents.on("will-navigate", (event, target) => { if (target.split("#")[0] !== url) event.preventDefault(); });
    viewer.on("page-title-updated", (event) => { event.preventDefault(); });
    viewer.once("closed", () => { this.windows.delete(file); });
    viewer.once("ready-to-show", () => viewer.show());
    try { await viewer.loadURL(url); }
    catch (error) { viewer.destroy(); throw new Error(`The PDF viewer could not open this document: ${(error as Error).message}`); }
  }
}
