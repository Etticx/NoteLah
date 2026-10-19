import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseStore } from "../electron/database";
import { Ollama } from "../electron/ollama";
import { RagService } from "../electron/rag";
import { bm25, chunkText, cosine, fuse, retrieve, type Chunk } from "../electron/retrieval";
import { createFolder, createNote } from "../src/lib/model";
import { normalizedText, structuredChunks, pdfPageText } from "../electron/chunking";
import { needsConversation, resolveQuestion } from "../electron/query";
import { answerMessages, checkedAnswer, promptBytes } from "../electron/answer";
import { contextBytes, rankCandidates, selectContext } from "../electron/retrieval";

const wasm = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");
const chunk = (id: string, text: string, vector = [1, 0]): Chunk => ({ id, text, title: id, vector, noteId: id, folderId: null, page: null, sectionHeading: null, chunkIndex: 0, startOffset: 0, endOffset: text.length });

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
  kind = "answer";
  rewrite: string | null = "Which university is listed for my degree?";
  queries: string[] = [];
  generationBodies: unknown[] = [];
  override async models() { return [{ name: "chat", digest: "chat1", embedding: false, chat: true }, { name: "embed", digest: this.digest, embedding: true, chat: false }]; }
  override async embed(_model: string, texts: string[], signal?: AbortSignal) {
    if (this.delay) await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 1000); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Stopped.")); }, { once: true }); });
    signal?.throwIfAborted();
    this.embeddedDocuments += texts.filter((text) => text.startsWith("search_document:")).length;
    this.queries.push(...texts.filter((text) => text.startsWith("search_query:")));
    return texts.map((text) => text.includes("groceries") ? [0, 1] : [1, 0]);
  }
  override async request(_endpoint: string, body?: unknown) {
    const input = body as { messages: { role: string; content: string }[] };
    if (input.messages[0].content.startsWith("Rewrite the latest question")) return { message: { content: JSON.stringify({ question: this.rewrite ?? "What about that?", needsClarification: !this.rewrite }) } };
    this.generationBodies.push(body);
    const labels = [...this.answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
    return { message: { content: JSON.stringify({ claims: [{ text: this.answer.replace(/\[\d+\]/g, ""), sources: labels }], kind: this.kind }) } };
  }
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

test("section chunks retain headings, exact normalized offsets, page boundaries, and stable order", () => {
  const original = "# Profile\nA student building useful tools.\n# Education\n" + "Bachelor of Information Systems. ".repeat(40) + "\n# Projects\nA credit risk system.";
  const pages = [{ text: original, page: 1 }, { text: "# Skills\nPython and TypeScript", page: 2 }];
  const pieces = structuredChunks(pages, 220, 40);
  assert.ok(pieces.some((piece) => piece.sectionHeading === "Education"));
  assert.ok(pieces.some((piece) => piece.sectionHeading === "Skills" && piece.page === 2));
  pieces.forEach((piece, index) => {
    const page = pages.find((page) => page.page === piece.page)!;
    assert.equal(normalizedText(page.text).slice(piece.startOffset, piece.endOffset), piece.text);
    assert.ok(piece.text.length <= 220); assert.equal(piece.chunkIndex, index);
  });
  const columns = pdfPageText([
    { str: "Education", transform: [12, 0, 0, 12, 10, 100], width: 70, height: 12 },
    { str: "Skills", transform: [12, 0, 0, 12, 300, 100], width: 40, height: 12, hasEOL: true },
    { str: "Python", transform: [10, 0, 0, 10, 300, 80], width: 35, height: 10, hasEOL: true },
  ]);
  assert.match(columns.text, /Education\nSkills\nPython/);
});

test("context selection includes more than three sections, merges overlap, respects bytes and scope", () => {
  const body = "# Profile\nStudent.\n# Education\nBachelor of Information Systems.\n# Skills\nPython.\n# Projects\nRisk models.\n# Awards\nHackathon finalist.\n# Certifications\nCloud fundamentals.";
  const chunks = structuredChunks([{ text: body, page: 1 }]).map((piece, i) => ({ ...chunk(String(i), piece.text), ...piece, noteId: "resume" }));
  const candidates = rankCandidates(chunks, "What is my specialty?", [1, 0]).candidates;
  const selected = selectContext(chunks, candidates, 5500);
  assert.ok(selected.length > 3);
  assert.ok(selected.some((source) => source.sectionHeading === "Education"));
  assert.equal(selectContext(chunks, candidates, 10).length, 0);
  assert.ok(contextBytes(selectContext(chunks, candidates, 800)) <= 800);
  const long = "A sentence about machine learning. ".repeat(60);
  const overlaps = structuredChunks([{ text: long, page: 1 }], 300, 70).map((piece, i) => ({ ...chunk(`overlap-${i}`, piece.text), ...piece, noteId: "one" }));
  const merged = selectContext(overlaps, rankCandidates(overlaps, "learning", [1, 0]).candidates, 5500);
  assert.equal(merged.length, 1); assert.equal(merged[0].text, long.trim());
  const unicode = [{ ...chunks[0], text: "知识".repeat(300) }];
  assert.ok(contextBytes(selectContext(unicode, rankCandidates(unicode, "知识", [1, 0]).candidates, 1000)) <= 1000);
});

test("independent questions exclude previous questions and answers; real follow-ups resolve separately", async () => {
  for (const question of ["What do I study?", "What is my specialty?", "What is IT?", "Summarize this resume", "Find documents that mention Python"]) assert.equal(needsConversation(question), false, question);
  assert.equal(needsConversation("Which university was that?"), true);
  const f = await setup();
  try {
    await f.store.save({ ...f.store.load(), notes: [createNote("Resume", "# Education\nBachelor of Information Systems at Example University.\n# Projects\nBuilt credit models.", null)] });
    const history = [{ question: "What is my specialty?", answer: "SECRET_PREVIOUS_ANSWER" }];
    const result = await f.rag.ask({ ...request, question: "What do I study?", history });
    assert.equal(result.trace.searchQuestion, "What do I study?"); assert.equal(result.trace.rewritten, false);
    assert.equal(f.ollama.queries.at(-1), "search_query: What do I study?");
    assert.ok(!JSON.stringify(f.ollama.generationBodies.at(-1)).includes("SECRET_PREVIOUS_ANSWER"));
    assert.ok(result.sources.some((source) => source.sectionHeading === "Education"));
    assert.equal(result.sources[0].sectionHeading, "Education");
    const followup = await f.rag.ask({ ...request, question: "Which university was that?", history });
    assert.equal(followup.trace.rewritten, true); assert.equal(followup.trace.searchQuestion, f.ollama.rewrite);
    f.ollama.rewrite = null;
    const clarification = await f.rag.ask({ ...request, question: "What about that?", history });
    assert.equal(clarification.kind, "clarification"); assert.equal(clarification.sources.length, 0);
    const noHistory = await resolveQuestion(f.ollama, { ...request, question: "What does it mean?" }, new AbortController().signal);
    assert.ok(noHistory.clarification);
  } finally { await f.cleanup(); }
});

test("answer validation distinguishes inference, abstains, and rejects fabricated or missing citations", () => {
  const sources = retrieve([chunk("a", "A degree in Information Systems.")], "degree", [1, 0]);
  assert.equal(checkedAnswer(JSON.stringify({ claims: [{ text: "You study Information Systems.", sources: [1] }], kind: "answer" }), sources).kind, "answer");
  assert.match(checkedAnswer(JSON.stringify({ claims: [{ text: "Your strengths suggest software development.", sources: [1] }], kind: "inference" }), sources).answer, /^Inference/);
  assert.equal(checkedAnswer(JSON.stringify({ claims: [{ text: "Unsupported answer", sources: [] }], kind: "answer" }), sources).kind, "insufficient");
  assert.equal(checkedAnswer(JSON.stringify({ claims: [{ text: "Something", sources: [999] }], kind: "answer" }), sources).kind, "insufficient");
  assert.ok(!checkedAnswer(JSON.stringify({ claims: [{ text: "Invented fact", sources: [1] }], kind: "insufficient" }), sources).answer.includes("Invented"));
  assert.equal(checkedAnswer("not JSON", sources).kind, "insufficient");
  const messages = answerMessages("What do I study?", "What do I study?", sources);
  assert.equal(messages[0].role, "system"); assert.equal(messages[1].role, "user");
  assert.ok(promptBytes("What do I study?", "What do I study?", sources) < 6500);
});

test("rebuilding an old search index cannot change the profile, tasks, notes, or source database bytes", async () => {
  const f = await setup();
  try {
    const current = f.store.load();
    current.profile.name = "Alif";
    current.notes.push(createNote("Education", "# Education\nBachelor of Information Systems.", null));
    await f.store.save(current);
    const sourceBytes = await fs.readFile(f.store.databasePath);
    await f.rag.ask({ ...request, question: "What do I study?" });
    assert.equal(f.ollama.embeddedDocuments, 1);
    f.rag.close();
    const SQL = await (await import("sql.js")).default({ locateFile: () => wasm });
    const index = new SQL.Database(await fs.readFile(f.rag.location));
    index.run("UPDATE configuration SET value='embed:version1:chunks-v1' WHERE key='embedding'");
    await fs.writeFile(f.rag.location, index.export()); index.close();
    await f.rag.initialize(wasm);
    await f.rag.ask({ ...request, question: "What do I study?" });
    assert.equal(f.ollama.embeddedDocuments, 2);
    assert.deepEqual(f.store.load(), current);
    assert.deepEqual(await fs.readFile(f.store.databasePath), sourceBytes);
  } finally { await f.cleanup(); }
});
