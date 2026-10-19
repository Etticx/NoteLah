import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseStore } from "../electron/database";
import { Ollama } from "../electron/ollama";
import { RagService } from "../electron/rag";
import { bm25, chunkText, cosine, fuse, retrieve, type Chunk } from "../electron/retrieval";
import { createFolder, createNote } from "../src/lib/model";

const wasm = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");
const chunk = (id: string, text: string, vector = [1, 0]): Chunk => ({ id, text, title: id, vector, noteId: id, folderId: null, page: null });

test("chunking bounds and overlap preserve long documents, Unicode, and the final passage", () => {
  const text = "A useful passage about submissions. ".repeat(100) + "FINAL_MARKER";
  const chunks = chunkText(text, 200, 30);
  assert.ok(chunks.length > 10);
  assert.ok(chunks.every((text) => text.length <= 200));
  assert.ok(chunks.at(-1)!.endsWith("FINAL_MARKER"));
  assert.deepEqual(chunkText(" \n "), []);
  assert.throws(() => chunkText("text", 10, 10));
});

test("BM25 matches exact identifiers, vector search adds semantic candidates, and RRF rewards agreement", () => {
  const chunks = [chunk("a", "SDC submission instructions", [0.4, 0.6]), chunk("b", "The SDC required deliverables include a working prototype", [1, 0]), chunk("c", "What the team needs to hand in", [0.9, 0.1]), chunk("d", "Groceries and cooking", [-1, 0])];
  assert.equal(bm25(chunks, "SDC").length, 2);
  assert.deepEqual(bm25(chunks, "nonexistentidentifier"), []);
  assert.equal(fuse([{ id: "a" }, { id: "b" }, { id: "d" }], [{ id: "b" }, { id: "c" }, { id: "a" }])[0].id, "b");
  assert.equal(fuse([{ id: "a" }, { id: "a" }], []).length, 1);
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-10);
  assert.throws(() => cosine([1], [1, 2]));
  const selected = retrieve(chunks, "SDC", [1, 0]);
  assert.ok(selected.some((source) => source.id === "c" && source.bm25Rank === null));
  assert.ok(!selected.some((source) => source.id === "d"));
  assert.ok(selected.every((source) => !("vector" in source)));
});

class FakeOllama extends Ollama {
  embeddedDocuments = 0;
  digest = "version1";
  answer = "Submit a prototype [1].";
  delay = false;
  override async models() { return [{ name: "chat", digest: "chat1", embedding: false, chat: true }, { name: "embed", digest: this.digest, embedding: true, chat: false }]; }
  override async embed(_model: string, texts: string[], signal?: AbortSignal) {
    if (this.delay) await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 1000); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Stopped.")); }, { once: true }); });
    signal?.throwIfAborted();
    this.embeddedDocuments += texts.filter((text) => text.startsWith("search_document:")).length;
    return texts.map((text) => text.includes("groceries") ? [0, 1] : [1, 0]);
  }
  override async request() { return { message: { content: this.answer } }; }
}

async function setup() {
  const root = path.resolve("work", `rag-test-${crypto.randomUUID()}`);
  const store = new DatabaseStore(root); await store.initialize(wasm);
  const ollama = new FakeOllama();
  const rag = new RagService(store, ollama); await rag.initialize(wasm);
  return { root, store, ollama, rag, async cleanup() { rag.close(); store.close(); assert.ok(root.startsWith(path.resolve("work") + path.sep)); await fs.rm(root, { recursive: true, force: true }); } };
}
const request = { question: "What must SDC submit?", folderId: null, chatModel: "chat", embeddingModel: "embed", history: [] };

test("persistent index reuses embeddings, filters folders, updates edits, removes deleted sources, and rebuilds on model changes", async () => {
  const f = await setup();
  try {
    const folder = createFolder("SDC");
    const other = createFolder("Personal");
    const note = createNote("SDC", "Submit a prototype and report.", folder.id);
    const personal = createNote("groceries", "groceries for dinner", other.id);
    await f.store.save({ ...f.store.load(), folders: [folder, other], notes: [note, personal] });
    const first = await f.rag.ask({ ...request, folderId: folder.id });
    assert.equal(first.sources.length, 1); assert.equal(first.sources[0].noteId, note.id);
    assert.equal(f.ollama.embeddedDocuments, 2);
    await f.rag.ask(request); assert.equal(f.ollama.embeddedDocuments, 2);
    f.rag.close(); await f.rag.initialize(wasm);
    await f.rag.ask(request); assert.equal(f.ollama.embeddedDocuments, 2);
    await f.store.save({ ...f.store.load(), notes: [{ ...note, body: "Submit an updated demo." }] });
    const updated = await f.rag.ask(request);
    assert.equal(updated.sources.length, 1); assert.match(updated.sources[0].text, /updated demo/);
    assert.equal(f.ollama.embeddedDocuments, 3);
    f.ollama.digest = "version2"; await f.rag.ask(request); assert.equal(f.ollama.embeddedDocuments, 4);
    await f.store.save({ ...f.store.load(), notes: [] });
    assert.equal((await f.rag.ask(request)).sources.length, 0);
    await f.rag.rebuild();
    assert.equal(f.store.load().folders.length, 2);
  } finally { await f.cleanup(); }
});

test("cancelled and stale indexing cannot publish, and uncited model output is withheld", async () => {
  const f = await setup();
  try {
    const note = createNote("SDC", "Submit a prototype.", null);
    await f.store.save({ ...f.store.load(), notes: [note] });
    f.ollama.delay = true;
    const pending = f.rag.ask(request);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await assert.rejects(f.rag.ask(request), /already running/);
    f.rag.cancel(); await assert.rejects(pending);
    assert.equal(f.rag.status.busy, false);
    const stale = f.rag.ask(request);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await f.store.save({ ...f.store.load(), notes: [{ ...note, body: "New requirements." }] });
    await assert.rejects(stale, /notes changed/);
    f.ollama.delay = false; f.ollama.answer = "Unsupported claim [999].";
    const reply = await f.rag.ask(request);
    assert.match(reply.answer, /could not produce an answer/);
    assert.ok(!reply.answer.includes("Unsupported claim"));
    assert.equal(reply.warnings.length, 1);
  } finally { await f.cleanup(); }
});

// Small valid PDF fixture: two pages with independently traceable text.
export function textPDF() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (const text of ["SDC requires a working prototype.", "Submission deadline is Friday at noon."]) { const stream = `BT /F1 12 Tf 40 700 Td (${text}) Tj ET`; objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); }
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

test("PDF extraction preserves page references and damaged PDFs produce visible warnings", async () => {
  const f = await setup();
  try {
    const pdf = path.join(f.root, "requirements.pdf"); await fs.writeFile(pdf, textPDF());
    await f.store.importFiles([pdf], null);
    const reply = await f.rag.ask(request);
    assert.equal(reply.warnings.length, 0, reply.warnings.join("\n"));
    assert.deepEqual(new Set(reply.sources.map((source) => source.page)), new Set([1, 2]));
    assert.ok(reply.sources.some((source) => source.page === 2 && source.text.includes("Friday")));
    const broken = path.join(f.root, "broken.pdf"); await fs.writeFile(broken, "%PDF-1.4\nnot a valid PDF");
    await f.store.importFiles([broken], null);
    assert.match((await f.rag.ask(request)).warnings.join(" "), /broken.pdf/);
  } finally { await f.cleanup(); }
});
