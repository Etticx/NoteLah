import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createNote, emptyWorkspace, exportBundle, fileKey, MAX_BACKUP_BYTES, MAX_FILE_BYTES, parseImport, workspaceSchema, type Note, type WorkspaceState } from "../src/lib/model";
import { localDate } from "../src/lib/dates";
import { FileLibrary, importedText, verifyFile, type FileContents } from "./library";

export async function atomicWrite(destination: string, bytes: string | Uint8Array) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.pending`;
  const handle = await fs.open(temporary, "w");
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, destination);
}

function value(db: Database, key: string): unknown {
  const statement = db.prepare("SELECT value FROM metadata WHERE key = ?");
  try {
    statement.bind([key]);
    if (!statement.step()) throw new Error(`Missing NoteLah metadata: ${key}`);
    return JSON.parse(statement.getAsObject().value as string);
  } finally { statement.free(); }
}

export function readDatabase(db: Database): WorkspaceState {
  const check = db.exec("PRAGMA quick_check");
  if (check[0]?.values[0]?.[0] !== "ok") throw new Error("This SQLite backup is damaged.");
  const version = db.exec("PRAGMA user_version")[0]?.values[0]?.[0];
  if (version !== 1 && version !== 2) throw new Error("This isn't a supported NoteLah SQLite backup.");
  const tasks: unknown[] = [];
  const statement = db.prepare("SELECT * FROM tasks ORDER BY created_at ASC");
  try {
    while (statement.step()) {
      const row = statement.getAsObject();
      tasks.push({ id: row.id, title: row.title, note: row.note, plannedDate: row.planned_date, completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at });
    }
  } finally { statement.free(); }
  const folders: unknown[] = [];
  const notes: unknown[] = [];
  if (version === 2) {
    const folderRows = db.prepare("SELECT * FROM folders ORDER BY rowid");
    try { while (folderRows.step()) { const row = folderRows.getAsObject(); folders.push({ id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at }); } } finally { folderRows.free(); }
    const noteRows = db.prepare("SELECT * FROM notes ORDER BY rowid");
    try { while (noteRows.step()) { const row = noteRows.getAsObject(); notes.push({ id: row.id, title: row.title, body: row.body, folderId: row.folder_id, file: row.file_json ? JSON.parse(row.file_json as string) : null, createdAt: row.created_at, updatedAt: row.updated_at }); } } finally { noteRows.free(); }
  }
  return workspaceSchema.parse({ version: 2, tasks, folders, notes, profile: value(db, "profile"), settings: value(db, "settings") });
}

export class DatabaseStore {
  private SQL!: SqlJsStatic;
  private db!: Database;
  private state!: WorkspaceState;
  private automaticFolder: string;
  private lastAutomaticDay: string | null = null;
  lastBackup: string | null = null;
  backupError: string | null = null;
  readonly library: FileLibrary;

  constructor(readonly directory: string) { this.automaticFolder = path.join(directory, "backups"); this.library = new FileLibrary(path.join(directory, "files")); }
  get databasePath() { return path.join(this.directory, "notelah.sqlite"); }
  get backupFolder() { return this.automaticFolder; }
  get filesBytes() { return [...new Map(this.state.notes.filter((note) => note.file).map((note) => [fileKey(note.file!), note.file!.size])).values()].reduce((total, size) => total + size, 0); }

  async initialize(wasmPath: string) {
    this.SQL = await initSqlJs({ locateFile: () => wasmPath });
    await fs.mkdir(this.directory, { recursive: true });
    let databaseFound = false;
    try {
      const saved = await fs.readFile(this.databasePath);
      databaseFound = true;
      this.db = new this.SQL.Database(saved);
      this.state = readDatabase(this.db);
      if (this.db.exec("PRAGMA user_version")[0].values[0][0] === 1) {
        await atomicWrite(path.join(this.directory, "backups", `NoteLah-before-notes-upgrade-${Date.now()}.sqlite`), this.db.export());
        this.createLibraryTables();
        await this.commit(this.state);
      }
    } catch (error) {
      if (databaseFound || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.db = new this.SQL.Database();
      this.db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, note TEXT NOT NULL, planned_date TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE INDEX tasks_planned_date ON tasks(planned_date); CREATE INDEX tasks_completed_at ON tasks(completed_at); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1;");
      this.createLibraryTables();
      await this.save(emptyWorkspace());
    }
    try {
      const preferences = JSON.parse(await fs.readFile(path.join(this.directory, "backup-preferences.json"), "utf8"));
      if (typeof preferences.folder === "string") this.automaticFolder = preferences.folder;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await this.refreshBackupInfo().catch((error: Error) => { this.backupError = error.message; });
    await this.attemptAutoBackup();
    return this.load();
  }

  load(): WorkspaceState { return structuredClone(this.state); }

  private createLibraryTables() {
    this.db.run("CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, folder_id TEXT, file_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS notes_folder ON notes(folder_id); PRAGMA user_version = 2;");
  }

  async save(input: WorkspaceState) {
    const next = workspaceSchema.parse(input);
    for (const note of next.notes) {
      if (note.file && JSON.stringify(note.file) !== JSON.stringify(this.state?.notes.find((old) => old.id === note.id)?.file)) throw new Error("Import files using the file picker, or restore a complete backup.");
    }
    await this.commit(next);
  }

  private async commit(next: WorkspaceState) {
    const oldState = this.state;
    const previous = this.db.export();
    this.db.run("BEGIN TRANSACTION");
    try {
      this.db.run("DELETE FROM tasks");
      const insert = this.db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)");
      try { for (const task of next.tasks) insert.run([task.id, task.title, task.note, task.plannedDate, task.completedAt, task.createdAt, task.updatedAt]); } finally { insert.free(); }
      this.db.run("DELETE FROM notes; DELETE FROM folders;");
      const folderInsert = this.db.prepare("INSERT INTO folders VALUES (?, ?, ?, ?)");
      try { for (const folder of next.folders) folderInsert.run([folder.id, folder.name, folder.createdAt, folder.updatedAt]); } finally { folderInsert.free(); }
      const noteInsert = this.db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?)");
      try { for (const note of next.notes) noteInsert.run([note.id, note.title, note.body, note.folderId, note.file ? JSON.stringify(note.file) : null, note.createdAt, note.updatedAt]); } finally { noteInsert.free(); }
      this.db.run("INSERT OR REPLACE INTO metadata VALUES (?, ?)", ["profile", JSON.stringify(next.profile)]);
      this.db.run("INSERT OR REPLACE INTO metadata VALUES (?, ?)", ["settings", JSON.stringify(next.settings)]);
      this.db.run("COMMIT");
      await atomicWrite(this.databasePath, this.db.export());
      this.state = next;
    } catch (error) {
      this.db.close(); this.db = new this.SQL.Database(previous);
      throw error;
    }
    await this.attemptAutoBackup();
    const retained = new Set(next.notes.filter((note) => note.file).map((note) => fileKey(note.file!)));
    const removed = new Map(oldState?.notes.filter((note) => note.file && !retained.has(fileKey(note.file))).map((note) => [fileKey(note.file!), note.file!]) ?? []);
    // Backups own their bytes; deleting a live note cannot damage an old backup.
    await Promise.all([...removed.values()].map((file) => fs.unlink(this.library.location(file)).catch(() => undefined)));
  }

  async readBackup(bytes: Uint8Array): Promise<WorkspaceState> {
    return (await this.decodeBackup(bytes)).state;
  }

  async decodeBackup(bytes: Uint8Array): Promise<{ state: WorkspaceState; files: FileContents }> {
    const database = new this.SQL.Database(bytes);
    try {
      const state = readDatabase(database);
      const files: FileContents = new Map();
      if (state.notes.some((note) => note.file)) {
        const statement = database.prepare("SELECT data FROM file_contents WHERE key = ?");
        try { for (const note of state.notes) { if (!note.file) continue; statement.bind([fileKey(note.file)]); if (!statement.step()) throw new Error(`The backup does not include ${note.file.name}.`); const bytes = statement.getAsObject().data as Uint8Array; verifyFile(note.file, bytes); files.set(fileKey(note.file), bytes.slice()); statement.reset(); } } finally { statement.free(); }
      }
      return { state, files };
    } finally { database.close(); }
  }

  decodeJSON(text: string): { state: WorkspaceState; files: FileContents } {
    const state = parseImport(text);
    const payload = JSON.parse(text);
    const files: FileContents = new Map();
    for (const note of state.notes) {
      if (!note.file) continue;
      const encoded = payload.fileData?.[fileKey(note.file)];
      if (typeof encoded !== "string" || encoded.length > MAX_FILE_BYTES * 1.34 + 8) throw new Error(`The backup does not include ${note.file.name}.`);
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) throw new Error("Invalid backup file data.");
      verifyFile(note.file, bytes); files.set(fileKey(note.file), bytes);
    }
    return { state, files };
  }

  async restore(state: WorkspaceState, files: FileContents) {
    const next = workspaceSchema.parse(state);
    const created = await this.library.stage(next, files);
    try { await this.commit(next); } catch (error) { await this.library.cleanupCreated(created); throw error; }
  }

  async importFiles(paths: string[], folderId: string | null) {
    if (folderId && !this.state.folders.some((folder) => folder.id === folderId)) throw new Error("Choose an existing folder.");
    if (paths.length > 10) throw new Error("Import up to 10 files at a time.");
    const notes: Note[] = [];
    const contents: FileContents = new Map();
    for (const source of paths) {
      const extension = path.extname(source).slice(1).toLowerCase();
      if (!["txt", "md", "pdf"].includes(extension)) throw new Error("Choose a .txt, .md, or .pdf file.");
      if ((await fs.stat(source)).size > MAX_FILE_BYTES) throw new Error("Choose a file smaller than 20 MB.");
      const bytes = await fs.readFile(source);
      if (bytes.length > MAX_FILE_BYTES) throw new Error("Choose a file smaller than 20 MB.");
      const name = path.basename(source);
      const note = createNote(name, importedText(extension, bytes), folderId);
      note.id = randomUUID();
      note.file = { name, extension: extension as "txt" | "md" | "pdf", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      notes.push(note); contents.set(fileKey(note.file), bytes);
    }
    await this.restore({ ...this.load(), notes: [...this.state.notes, ...notes] }, contents);
    return this.load();
  }

  async exportJSON() {
    const fileData: Record<string, string> = {};
    for (const note of this.state.notes) if (note.file && !fileData[fileKey(note.file)]) fileData[fileKey(note.file)] = (await this.library.read(note.file)).toString("base64");
    return JSON.stringify({ ...exportBundle(this.state), fileData }, null, 2);
  }

  async backup(destination: string) {
    if (path.resolve(destination).toLowerCase() === path.resolve(this.databasePath).toLowerCase()) throw new Error("Choose a different file from your active database.");
    if (path.resolve(destination).toLowerCase().startsWith(path.resolve(this.library.directory).toLowerCase() + path.sep)) throw new Error("Choose a backup location outside the imported files folder.");
    const snapshot = new this.SQL.Database(this.db.export());
    try {
      snapshot.run("CREATE TABLE IF NOT EXISTS file_contents (key TEXT PRIMARY KEY, data BLOB NOT NULL)");
      const insert = snapshot.prepare("INSERT OR REPLACE INTO file_contents VALUES (?, ?)");
      try { for (const note of this.state.notes) if (note.file) insert.run([fileKey(note.file), await this.library.read(note.file)]); } finally { insert.free(); }
      const bytes = snapshot.export();
      if (bytes.length > MAX_BACKUP_BYTES) throw new Error("The complete backup exceeds 100 MB. Reduce the library size before backing up.");
      await atomicWrite(destination, bytes);
    } finally { snapshot.close(); }
    this.lastBackup = new Date().toISOString();
  }

  async backupBeforeRestore() {
    const suffix = new Date().toISOString().replaceAll(/[:.]/g, "-");
    await this.backup(path.join(this.automaticFolder, `NoteLah-before-restore-${suffix}.sqlite`));
  }

  async chooseFolder(folder: string) {
    await fs.mkdir(folder, { recursive: true });
    await atomicWrite(path.join(this.directory, "backup-preferences.json"), JSON.stringify({ folder }));
    this.automaticFolder = folder;
    this.lastAutomaticDay = null;
    await this.refreshBackupInfo();
    await this.autoBackup();
    this.backupError = null;
  }

  private async refreshBackupInfo() {
    await fs.mkdir(this.automaticFolder, { recursive: true });
    const files = (await fs.readdir(this.automaticFolder)).filter((name) => /^NoteLah-auto-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)).sort();
    const latest = files.at(-1);
    if (latest) {
      this.lastAutomaticDay = latest.slice(13, 23);
      this.lastBackup = (await fs.stat(path.join(this.automaticFolder, latest))).mtime.toISOString();
    }
  }

  private async autoBackup() {
    if (!this.state?.settings.automaticBackups) return;
    const today = localDate();
    if (today === this.lastAutomaticDay) return;
    await this.backup(path.join(this.automaticFolder, `NoteLah-auto-${today}.sqlite`));
    this.lastAutomaticDay = today;
    const files = (await fs.readdir(this.automaticFolder)).filter((name) => /^NoteLah-auto-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)).sort();
    for (const name of files.slice(0, -7)) await fs.unlink(path.join(this.automaticFolder, name));
  }

  private async attemptAutoBackup() {
    try { await this.autoBackup(); this.backupError = null; }
    catch (error) { this.backupError = `Your work is saved, but the automatic backup couldn't be created. ${(error as Error).message}`; }
  }

  close() { this.db?.close(); }
}
