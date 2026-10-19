import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { DatabaseStore } from "../electron/database";
import { createFolder, createNote, createTask, emptyWorkspace, fileKey, workspaceSchema } from "../src/lib/model";

const wasm = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");
async function setup() {
  const root = path.resolve("work", `notes-test-${crypto.randomUUID()}`);
  const store = new DatabaseStore(path.join(root, "data"));
  await store.initialize(wasm);
  return { root, store, async cleanup() { store.close(); assert.ok(root.startsWith(path.resolve("work") + path.sep)); await fs.rm(root, { recursive: true, force: true }); } };
}

test("version-one data upgrades with an untouched recovery copy and preserves tasks", async () => {
  const fixture = await setup();
  try {
    fixture.store.close();
    const SQL = await initSqlJs({ locateFile: () => wasm });
    const legacy = new SQL.Database();
    const task = createTask("Existing task", "2026-10-19", "Legacy content");
    legacy.run("CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT,note TEXT,planned_date TEXT,completed_at TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT); PRAGMA user_version=1;");
    legacy.run("INSERT INTO tasks VALUES (?,?,?,?,?,?,?)", [task.id, task.title, task.note, task.plannedDate, null, task.createdAt, task.updatedAt]);
    const initial = emptyWorkspace();
    legacy.run("INSERT INTO metadata VALUES (?,?)", ["profile", JSON.stringify(initial.profile)]);
    legacy.run("INSERT INTO metadata VALUES (?,?)", ["settings", JSON.stringify(initial.settings)]);
    const bytes = Buffer.from(legacy.export()); legacy.close();
    await fs.writeFile(fixture.store.databasePath, bytes);
    const rename = fs.rename;
    fs.rename = async (source, destination) => {
      if (String(destination).includes("NoteLah-before-notes-upgrade-")) throw Object.assign(new Error("Forced recovery-copy failure"), { code: "ENOENT" });
      return rename(source, destination);
    };
    try { await assert.rejects(() => fixture.store.initialize(wasm), /Forced recovery-copy failure/); }
    finally { fs.rename = rename; fixture.store.close(); }
    assert.deepEqual(await fs.readFile(fixture.store.databasePath), bytes, "Failed migration must not reset the existing database");
    await fixture.store.initialize(wasm);
    assert.deepEqual(fixture.store.load().tasks, [task]);
    assert.equal(fixture.store.load().version, 2);
    assert.deepEqual(fixture.store.load().notes, []);
    const backup = (await fs.readdir(fixture.store.backupFolder)).find((name) => name.startsWith("NoteLah-before-notes-upgrade-"));
    assert.ok(backup);
    assert.deepEqual(await fs.readFile(path.join(fixture.store.backupFolder, backup)), bytes);
  } finally { await fixture.cleanup(); }
});

test("notes and folders survive reopening, and dangling folders or duplicate notes are rejected", async () => {
  const fixture = await setup();
  try {
    const state = fixture.store.load(); const folder = createFolder("Degree project");
    const note = createNote("Meeting", "Discuss chapter two\nKeep the scope small.", folder.id);
    state.folders.push(folder); state.notes.push(note);
    await fixture.store.save(state); fixture.store.close(); await fixture.store.initialize(wasm);
    assert.deepEqual(fixture.store.load(), state);
    assert.equal(workspaceSchema.safeParse({ ...state, folders: [] }).success, false);
    assert.equal(workspaceSchema.safeParse({ ...state, notes: [note, note] }).success, false);
    await fixture.store.save({ ...state, folders: [], notes: [{ ...note, folderId: null }] });
    assert.equal(fixture.store.load().notes[0].body, note.body);
  } finally { await fixture.cleanup(); }
});

test("TXT, Markdown, and PDF copies restore from SQLite and JSON with no original files", async () => {
  const fixture = await setup();
  const restored = await setup();
  try {
    const text = path.join(fixture.root, "meeting.txt"); const md = path.join(fixture.root, "ideas.md"); const pdf = path.join(fixture.root, "reference.pdf");
    await fs.writeFile(text, "A meeting about retrieval.\nNext: write notes.");
    await fs.writeFile(md, "# Ideas\nKeep everything local.\n");
    await fs.writeFile(pdf, "%PDF-1.4\n% Test document bytes\n%%EOF");
    await fixture.store.importFiles([text, md, pdf], null);
    const state = fixture.store.load();
    assert.equal(state.notes.length, 3);
    assert.match(state.notes.find((note) => note.file?.extension === "md")!.body, /# Ideas/);
    assert.equal(state.notes.find((note) => note.file?.extension === "pdf")!.body, "");
    await Promise.all([text, md, pdf].map((file) => fs.unlink(file)));
    const backup = path.join(fixture.root, "complete.sqlite"); await fixture.store.backup(backup);
    const decoded = await restored.store.decodeBackup(await fs.readFile(backup));
    await restored.store.restore(decoded.state, decoded.files);
    assert.deepEqual(restored.store.load(), state);
    for (const note of state.notes) assert.deepEqual(await restored.store.library.read(note.file!), await fixture.store.library.read(note.file!));
    const json = fixture.store.decodeJSON(await fixture.store.exportJSON());
    assert.deepEqual(json.state, state); assert.equal(json.files.size, 3);
    const first = state.notes[0];
    await fs.writeFile(restored.store.library.location(first.file!), "damaged");
    await restored.store.restore(json.state, json.files);
    assert.deepEqual(await restored.store.library.read(first.file!), json.files.get(fileKey(first.file!)));
    const archive = JSON.parse(await fixture.store.exportJSON());
    archive.fileData[fileKey(first.file!)] = Buffer.from("altered").toString("base64");
    assert.throws(() => fixture.store.decodeJSON(JSON.stringify(archive)), /damaged/);
    assert.deepEqual(fixture.store.load(), state);
  } finally { await fixture.cleanup(); await restored.cleanup(); }
});

test("imports are atomic, reject disguised files, and preserve duplicate names independently", async () => {
  const fixture = await setup();
  try {
    const one = path.join(fixture.root, "one"); const two = path.join(fixture.root, "two");
    await fs.mkdir(one); await fs.mkdir(two);
    const first = path.join(one, "notes.txt"); const second = path.join(two, "notes.txt"); const fake = path.join(one, "fake.pdf");
    await fs.writeFile(first, "First document"); await fs.writeFile(second, "Second document"); await fs.writeFile(fake, "Not a PDF");
    await assert.rejects(() => fixture.store.importFiles([first, fake], null), /valid PDF/);
    assert.equal(fixture.store.load().notes.length, 0);
    await fixture.store.importFiles([first, second], null);
    const notes = fixture.store.load().notes;
    assert.notEqual(notes[0].file!.sha256, notes[1].file!.sha256);
    assert.equal((await fixture.store.library.read(notes[0].file!)).toString(), "First document");
    const forged = { ...fixture.store.load(), notes: [...notes, { ...notes[0], id: crypto.randomUUID() }] };
    await assert.rejects(() => fixture.store.save(forged), /file picker/);
    await assert.rejects(() => fixture.store.importFiles([first], crypto.randomUUID()), /existing folder/);
  } finally { await fixture.cleanup(); }
});

test("deleting imported notes frees live copies but old backups still restore them", async () => {
  const fixture = await setup();
  try {
    const original = path.join(fixture.root, "keep.txt"); await fs.writeFile(original, "Important content");
    await fixture.store.importFiles([original], null);
    const state = fixture.store.load(); const note = state.notes[0];
    const backup = path.join(fixture.root, "saved.sqlite"); await fixture.store.backup(backup);
    await fixture.store.save({ ...state, notes: [] });
    await assert.rejects(() => fs.access(fixture.store.library.location(note.file!)));
    assert.equal((await fs.readFile(original)).toString(), "Important content");
    const decoded = await fixture.store.decodeBackup(await fs.readFile(backup)); await fixture.store.restore(decoded.state, decoded.files);
    assert.equal((await fixture.store.library.read(note.file!)).toString(), "Important content");
    await fs.unlink(fixture.store.library.location(note.file!));
    await assert.rejects(() => fixture.store.backup(path.join(fixture.root, "incomplete.sqlite")), /could not be found/);
  } finally { await fixture.cleanup(); }
});
