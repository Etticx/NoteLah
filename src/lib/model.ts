import { z } from "zod";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const timestamp = z.iso.datetime({ offset: true });

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_LIBRARY_BYTES = 50 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
export const folderSchema = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(100), createdAt: timestamp, updatedAt: timestamp });
export const noteSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(300), body: z.string().max(MAX_TEXT_BYTES), folderId: z.string().uuid().nullable(),
  file: z.object({ name: z.string().min(1).max(255), extension: z.enum(["txt", "md", "pdf"]), size: z.number().int().min(0).max(MAX_FILE_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).nullable(),
  createdAt: timestamp, updatedAt: timestamp,
});

export const taskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(500),
  note: z.string().max(20000),
  plannedDate: day.nullable(),
  completedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const workspaceSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]).transform(() => 2 as const),
  tasks: z.array(taskSchema).max(50000).refine((tasks) => new Set(tasks.map((task) => task.id)).size === tasks.length, "Duplicate task IDs"),
  folders: z.array(folderSchema).max(1000).default([]),
  notes: z.array(noteSchema).max(10000).default([]),
  profile: z.object({ name: z.string().trim().max(100), role: z.string().trim().max(160), bio: z.string().max(1000) }),
  settings: z.object({ automaticBackups: z.boolean(), weekStartsOn: z.union([z.literal(0), z.literal(1)]) }),
}).superRefine((state, context) => {
  const folders = new Set(state.folders.map((folder) => folder.id));
  if (folders.size !== state.folders.length || new Set(state.notes.map((note) => note.id)).size !== state.notes.length) context.addIssue({ code: "custom", message: "Duplicate library IDs" });
  if (state.notes.some((note) => note.folderId !== null && !folders.has(note.folderId))) context.addIssue({ code: "custom", message: "A note belongs to a missing folder" });
  const files = new Map(state.notes.filter((note) => note.file).map((note) => [fileKey(note.file!), note.file!.size]));
  if ([...files.values()].reduce((total, size) => total + size, 0) > MAX_LIBRARY_BYTES) context.addIssue({ code: "custom", message: "Imported files must total no more than 50 MB" });
});

export const exportSchema = workspaceSchema.safeExtend({ exportedAt: timestamp });

export type Task = z.infer<typeof taskSchema>;
export type Note = z.infer<typeof noteSchema>;
export type NoteFolder = z.infer<typeof folderSchema>;
export type NoteFile = NonNullable<Note["file"]>;
export type WorkspaceState = z.infer<typeof workspaceSchema>;
export type ExportBundle = z.infer<typeof exportSchema>;
export type StorageInfo = { mode: "desktop" | "browser"; location: string; backupFolder: string | null; lastBackup: string | null; backupError?: string | null; filesLocation?: string; filesBytes?: number };
export type SaveResult = { canceled: boolean; path?: string };
export type RestorePreview = { token: string; state: WorkspaceState; date: string | null; fileName: string };

export interface DesktopAPI {
  load(): Promise<{ state: WorkspaceState; info: StorageInfo }>;
  save(state: WorkspaceState): Promise<StorageInfo>;
  setDirty(value: boolean): void;
  backup(): Promise<SaveResult>;
  chooseBackupFolder(): Promise<StorageInfo | null>;
  exportData(format: "json" | "csv"): Promise<SaveResult>;
  selectRestore(): Promise<RestorePreview | null>;
  restore(token: string): Promise<{ state: WorkspaceState; info: StorageInfo }>;
  importNotes(folderId: string | null): Promise<{ state: WorkspaceState; info: StorageInfo } | null>;
  importDroppedNotes(folderId: string | null, files: File[]): Promise<{ state: WorkspaceState; info: StorageInfo }>;
  openNoteFile(noteId: string): Promise<void>;
  openNotesFolder(): Promise<void>;
}

export function emptyWorkspace(): WorkspaceState {
  return { version: 2, tasks: [], folders: [], notes: [], profile: { name: "", role: "", bio: "" }, settings: { automaticBackups: true, weekStartsOn: 1 } };
}

export function fileKey(file: NoteFile): string { return `${file.sha256}.${file.extension}`; }
export function createFolder(name: string): NoteFolder {
  const now = new Date().toISOString();
  return folderSchema.parse({ id: crypto.randomUUID(), name, createdAt: now, updatedAt: now });
}
export function createNote(title: string, body: string, folderId: string | null): Note {
  const now = new Date().toISOString();
  return noteSchema.parse({ id: crypto.randomUUID(), title, body, folderId, file: null, createdAt: now, updatedAt: now });
}

export function createTask(title: string, plannedDate: string | null, note = ""): Task {
  const now = new Date().toISOString();
  return taskSchema.parse({ id: crypto.randomUUID(), title, note, plannedDate, completedAt: null, createdAt: now, updatedAt: now });
}

export function exportBundle(state: WorkspaceState): ExportBundle {
  return exportSchema.parse({ ...state, exportedAt: new Date().toISOString() });
}

export function parseImport(text: string): WorkspaceState {
  const parsed = workspaceSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error("This isn't a valid NoteLah backup. Choose a NoteLah JSON export or SQLite backup.");
  return parsed.data;
}

function csvCell(value: string): string {
  // Prevent spreadsheet formulas from running when a task title is opened in Excel.
  const safe = /^[=+@\-\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function tasksCSV(state: WorkspaceState): string {
  const rows = ["Title,Notes,Planned date,Status,Completed at,Created at"];
  for (const task of state.tasks) rows.push([task.title, task.note, task.plannedDate ?? "", task.completedAt ? "Completed" : "To do", task.completedAt ?? "", task.createdAt].map(csvCell).join(","));
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}
