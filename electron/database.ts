import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { emptyWorkspace, workspaceSchema, type WorkspaceState } from "../src/lib/model";
import { localDate } from "../src/lib/dates";

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
  if (version !== 1) throw new Error("This isn't a supported NoteLah SQLite backup.");
  const tasks: unknown[] = [];
  const statement = db.prepare("SELECT * FROM tasks ORDER BY created_at ASC");
  try {
    while (statement.step()) {
      const row = statement.getAsObject();
      tasks.push({ id: row.id, title: row.title, note: row.note, plannedDate: row.planned_date, completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at });
    }
  } finally { statement.free(); }
  return workspaceSchema.parse({ version: 1, tasks, profile: value(db, "profile"), settings: value(db, "settings") });
}

export class DatabaseStore {
  private SQL!: SqlJsStatic;
  private db!: Database;
  private state!: WorkspaceState;
  private automaticFolder: string;
  private lastAutomaticDay: string | null = null;
  lastBackup: string | null = null;
  backupError: string | null = null;

  constructor(readonly directory: string) { this.automaticFolder = path.join(directory, "backups"); }
  get databasePath() { return path.join(this.directory, "notelah.sqlite"); }
  get backupFolder() { return this.automaticFolder; }

  async initialize(wasmPath: string) {
    this.SQL = await initSqlJs({ locateFile: () => wasmPath });
    await fs.mkdir(this.directory, { recursive: true });
    try {
      this.db = new this.SQL.Database(await fs.readFile(this.databasePath));
      this.state = readDatabase(this.db);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.db = new this.SQL.Database();
      this.db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, note TEXT NOT NULL, planned_date TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE INDEX tasks_planned_date ON tasks(planned_date); CREATE INDEX tasks_completed_at ON tasks(completed_at); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1;");
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

  async save(input: WorkspaceState) {
    const next = workspaceSchema.parse(input);
    const previous = this.db.export();
    this.db.run("BEGIN TRANSACTION");
    try {
      this.db.run("DELETE FROM tasks");
      const insert = this.db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)");
      try { for (const task of next.tasks) insert.run([task.id, task.title, task.note, task.plannedDate, task.completedAt, task.createdAt, task.updatedAt]); } finally { insert.free(); }
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
  }

  async readBackup(bytes: Uint8Array): Promise<WorkspaceState> {
    const database = new this.SQL.Database(bytes);
    try { return readDatabase(database); } finally { database.close(); }
  }

  async backup(destination: string) {
    if (path.resolve(destination).toLowerCase() === path.resolve(this.databasePath).toLowerCase()) throw new Error("Choose a different file from your active database.");
    await atomicWrite(destination, this.db.export());
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
