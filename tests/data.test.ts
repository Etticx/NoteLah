import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseStore } from "../electron/database";
import { createTask, emptyWorkspace, exportBundle, parseImport, tasksCSV, workspaceSchema } from "../src/lib/model";
import { localDate, shiftDay, completionDay } from "../src/lib/dates";

const wasm = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");
async function temporaryStore() {
  const directory = path.resolve("work", `test-data-${crypto.randomUUID()}`);
  const store = new DatabaseStore(directory);
  await store.initialize(wasm);
  return { store, directory };
}
async function cleanup(directory: string) {
  const root = path.resolve("work") + path.sep;
  assert.ok(directory.startsWith(root));
  await fs.rm(directory, { recursive: true, force: true });
}

test("SQLite survives reopening and produces a valid complete backup", async () => {
  const { store, directory } = await temporaryStore();
  try {
    const state = emptyWorkspace();
    state.tasks.push(createTask("Write a proposal", "2026-10-12", "Some notes, with a comma."));
    state.tasks[0].completedAt = "2026-10-13T09:00:00+08:00";
    state.profile.name = "A person";
    await store.save(state);
    const backup = path.join(directory, "manual.sqlite");
    await store.backup(backup);
    assert.deepEqual(await store.readBackup(await fs.readFile(backup)), state);
    store.close();
    const reopened = new DatabaseStore(directory);
    await reopened.initialize(wasm);
    assert.deepEqual(reopened.load(), state);
    reopened.close();
  } finally { store.close(); await cleanup(directory); }
});

test("invalid imports and duplicate IDs are rejected without touching saved data", async () => {
  const { store, directory } = await temporaryStore();
  try {
    const state = emptyWorkspace(); state.tasks.push(createTask("Keep this task", null));
    await store.save(state);
    assert.throws(() => parseImport('{"version":1,"tasks":[]}'));
    const duplicate = { ...state, tasks: [state.tasks[0], state.tasks[0]] };
    await assert.rejects(() => store.save(duplicate));
    assert.deepEqual(store.load(), state);
    await assert.rejects(() => store.readBackup(new Uint8Array([1, 2, 3])));
    assert.deepEqual(store.load(), state);
    assert.equal(workspaceSchema.safeParse({ ...state, tasks: [{ ...state.tasks[0], plannedDate: "2026-02-30" }] }).success, false);
  } finally { store.close(); await cleanup(directory); }
});

test("a copy of current data exists before a restore replaces the workspace", async () => {
  const { store, directory } = await temporaryStore();
  try {
    const before = emptyWorkspace(); before.tasks.push(createTask("Keep a recovery copy", null));
    await store.save(before); await store.backupBeforeRestore(); await store.save(emptyWorkspace());
    const backups = (await fs.readdir(store.backupFolder)).filter((file) => file.startsWith("NoteLah-before-restore-"));
    assert.equal(backups.length, 1);
    assert.deepEqual(await store.readBackup(await fs.readFile(path.join(store.backupFolder, backups[0]))), before);
    assert.equal(store.load().tasks.length, 0);
  } finally { store.close(); await cleanup(directory); }
});

test("JSON round-trips and CSV safely quotes task text and neutralizes formulas", () => {
  const state = emptyWorkspace();
  state.tasks.push(createTask('=HYPERLINK("example")', null, 'Line one\n"Quoted", comma'));
  assert.deepEqual(parseImport(JSON.stringify(exportBundle(state))), state);
  const csv = tasksCSV(state);
  assert.ok(csv.includes('"\'=HYPERLINK(""example"")"'));
  assert.ok(csv.includes('"Line one\n""Quoted"", comma"'));
});

test("planner days remain correct across month, year, and leap-day boundaries", () => {
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDay("2024-02-28", 1), "2024-02-29");
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
  const timestamp = "2026-10-12T23:30:00Z";
  assert.equal(completionDay(timestamp), localDate(new Date(timestamp)));
});

test("an unavailable backup folder does not prevent saving or opening the main database", async () => {
  const { store, directory } = await temporaryStore();
  try {
    const blocker = path.join(directory, "not-a-folder");
    await fs.writeFile(blocker, "A file cannot be used as a backup directory.");
    await fs.writeFile(path.join(directory, "backup-preferences.json"), JSON.stringify({ folder: blocker }));
    store.close();
    const reopened = new DatabaseStore(directory);
    await reopened.initialize(wasm);
    const state = reopened.load(); state.tasks.push(createTask("Save even when backup isn't available", null));
    await reopened.save(state);
    assert.equal(reopened.load().tasks.length, 1);
    assert.ok(reopened.backupError);
    await reopened.chooseFolder(path.join(directory, "available-backups"));
    assert.equal(reopened.backupError, null);
    reopened.close();
    const again = new DatabaseStore(directory);
    await again.initialize(wasm);
    assert.equal(again.load().tasks.length, 1);
    again.close();
  } finally { store.close(); await cleanup(directory); }
});

test("daily backup retention keeps seven snapshots and preserves recovery copies", async () => {
  const { store, directory } = await temporaryStore();
  try {
    const bytes = await fs.readFile(store.databasePath);
    const folder = store.backupFolder;
    const current = path.join(folder, `NoteLah-auto-${localDate()}.sqlite`);
    await fs.rename(current, path.join(folder, "NoteLah-auto-1999-12-31.sqlite"));
    for (let index = 1; index <= 10; index++) await fs.writeFile(path.join(folder, `NoteLah-auto-2000-01-${String(index).padStart(2, "0")}.sqlite`), bytes);
    await fs.writeFile(path.join(folder, "NoteLah-before-restore-preserved.sqlite"), bytes);
    store.close();
    const reopened = new DatabaseStore(directory);
    await reopened.initialize(wasm);
    const files = await fs.readdir(folder);
    assert.equal(files.filter((file) => file.startsWith("NoteLah-auto-")).length, 7);
    assert.ok(files.includes(`NoteLah-auto-${localDate()}.sqlite`));
    assert.ok(files.includes("NoteLah-before-restore-preserved.sqlite"));
    reopened.close();
  } finally { store.close(); await cleanup(directory); }
});
