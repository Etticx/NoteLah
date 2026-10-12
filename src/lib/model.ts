import { z } from "zod";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const timestamp = z.iso.datetime({ offset: true });

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
  version: z.literal(1),
  tasks: z.array(taskSchema).max(50000).refine((tasks) => new Set(tasks.map((task) => task.id)).size === tasks.length, "Duplicate task IDs"),
  profile: z.object({ name: z.string().trim().max(100), role: z.string().trim().max(160), bio: z.string().max(1000) }),
  settings: z.object({ automaticBackups: z.boolean(), weekStartsOn: z.union([z.literal(0), z.literal(1)]) }),
});

export const exportSchema = workspaceSchema.extend({ exportedAt: timestamp });

export type Task = z.infer<typeof taskSchema>;
export type WorkspaceState = z.infer<typeof workspaceSchema>;
export type ExportBundle = z.infer<typeof exportSchema>;
export type StorageInfo = { mode: "desktop" | "browser"; location: string; backupFolder: string | null; lastBackup: string | null; backupError?: string | null };
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
}

export function emptyWorkspace(): WorkspaceState {
  return { version: 1, tasks: [], profile: { name: "", role: "", bio: "" }, settings: { automaticBackups: true, weekStartsOn: 1 } };
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
