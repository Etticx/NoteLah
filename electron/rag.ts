import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { atomicWrite, type DatabaseStore } from "./database";
import { Ollama } from "./ollama";
import { contextBytes, keywordQuery, rankCandidates, selectContext, type Chunk } from "./retrieval";
import { pdfPageText, structuredChunks, type TextPage } from "./chunking";
import { resolveQuestion } from "./query";
import { answerFormat, answerLimit, answerMessages, checkedAnswer, promptBytes } from "./answer";
import type { RagRequest, RagReply, RagStatus } from "../src/lib/rag-types";
import type { Note, WorkspaceState } from "../src/lib/model";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fingerprint = (note: Note) => hash(JSON.stringify([note.id, note.title, note.body, note.folderId, note.file]));
const libraryFingerprint = (state: WorkspaceState) => hash(JSON.stringify(state.notes.map(fingerprint).sort()));
type CachedDocument = { fingerprint: string; chunks: Chunk[]; warning: string | null };
export const ragRequestSchema = z.object({ question: z.string().trim().min(1).max(2000), folderId: z.string().uuid().nullable(), chatModel: z.string().min(1).max(150), embeddingModel: z.string().min(1).max(150), history: z.array(z.object({ question: z.string().max(2000), answer: z.string().max(12000) })).max(4) });

export class RagService {
  private SQL!: SqlJsStatic;
  private db!: Database;
  private active: AbortController | null = null;
  status: RagStatus = { busy: false, message: "Ready", completed: 0, total: 0 };
  constructor(private readonly store: DatabaseStore, private readonly ollama = new Ollama()) {}
  get location() { return path.join(this.store.directory, "search-index.sqlite"); }
  async initialize(wasm: string) {
    this.SQL = await initSqlJs({ locateFile: () => wasm });
    try {
      this.db = new this.SQL.Database(await fs.readFile(this.location));
      if (this.db.exec("PRAGMA quick_check")[0]?.values[0]?.[0] !== "ok") throw new Error("Invalid index");
      this.db.exec("SELECT id, data FROM documents; SELECT value FROM configuration");
    } catch { this.db?.close(); this.db = this.emptyIndex(); }
  }
  private emptyIndex() {
    const db = new this.SQL.Database();
    db.run("CREATE TABLE documents (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE configuration (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    return db;
  }
  cancel() { this.active?.abort(); }
  models() { return this.ollama.models(); }
  private progress(message: string, completed = 0, total = 0) { this.status = { busy: true, message, completed, total }; }
  private async exclusive<T>(run: (signal: AbortSignal) => Promise<T>) {
    if (this.active) throw new Error("A chat operation is already running.");
    this.active = new AbortController();
    try { return await run(this.active.signal); }
    finally { this.active = null; this.status = { busy: false, message: "Ready", completed: 0, total: 0 }; }
  }
  async rebuild() {
    if (this.active) throw new Error("Stop the current operation before resetting the index.");
    const replacement = this.emptyIndex();
    try { await atomicWrite(this.location, replacement.export()); }
    catch (error) { replacement.close(); throw error; }
    this.db.close(); this.db = replacement;
  }
  async extract(note: Note, signal: AbortSignal): Promise<TextPage[]> {
    if (note.file?.extension !== "pdf") return [{ text: note.body, page: null }];
    const bytes = await this.store.library.read(note.file);
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdfAssets = path.dirname(require.resolve("pdfjs-dist/package.json"));
    const assetFolder = (name: string) => path.join(pdfAssets, name).replaceAll("\\", "/") + "/";
    const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, useWorkerFetch: false, standardFontDataUrl: assetFolder("standard_fonts"), cMapUrl: assetFolder("cmaps"), cMapPacked: true, wasmUrl: assetFolder("wasm") });
    const abort = () => { void loading.destroy(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const pdf = await loading.promise;
      if (pdf.numPages > 500) throw new Error("PDF exceeds the 500-page indexing limit.");
      const pages: TextPage[] = [];
      let length = 0;
      for (let page = 1; page <= pdf.numPages; page++) {
        signal.throwIfAborted();
        const documentPage = await pdf.getPage(page);
        const content = await documentPage.getTextContent();
        const pageText = pdfPageText(content.items.filter((item): item is import("pdfjs-dist/types/src/display/api").TextItem => "str" in item));
        const text = pageText.text;
        length += text.length;
        if (length > 2_000_000) throw new Error("PDF exceeds the text indexing limit.");
        pages.push({ ...pageText, page }); documentPage.cleanup();
      }
      if (!pages.some((page) => page.text.trim())) throw new Error("No extractable text. Scanned PDFs need OCR, which is not included yet.");
      return pages;
    } finally { signal.removeEventListener("abort", abort); await loading.destroy(); }
  }
  private async sync(state: WorkspaceState, model: string, digest: string, signal: AbortSignal) {
    const identity = `${model}:${digest}:sections-v2`;
    const savedIdentity = this.db.exec("SELECT value FROM configuration WHERE key='embedding'")[0]?.values[0]?.[0];
    const cached = new Map<string, CachedDocument>();
    if (savedIdentity === identity) {
      const rows = this.db.exec("SELECT id, data FROM documents")[0]?.values ?? [];
      for (const row of rows) cached.set(String(row[0]), JSON.parse(String(row[1])));
    }
    if (cached.size === state.notes.length && state.notes.every((note) => {
      const document = cached.get(note.id);
      return document?.fingerprint === fingerprint(note) && !document.warning;
    })) {
      const chunks = state.notes.flatMap((note) => cached.get(note.id)!.chunks);
      if (chunks.length > 5000) throw new Error("The library exceeds 5,000 searchable chunks.");
      return { chunks, warnings: [] as string[] };
    }
    const next = this.emptyIndex();
    const all: Chunk[] = [], warnings: string[] = [];
    try {
      next.run("INSERT INTO configuration VALUES ('embedding', ?)", [identity]);
      for (let index = 0; index < state.notes.length; index++) {
        signal.throwIfAborted();
        const note = state.notes[index];
        this.progress(`Preparing ${note.title}`, index, state.notes.length);
        let document = cached.get(note.id);
        if (!document || document.fingerprint !== fingerprint(note) || document.warning) {
          let chunks: Chunk[] = [], warning: string | null = null;
          let pages: TextPage[] = [];
          try { pages = await this.extract(note, signal); }
          catch (error) { if (signal.aborted) throw error; warning = `${note.title}: ${(error as Error).message}`; }
          const pieces = structuredChunks(pages);
          if (pieces.length + all.length > 5000) throw new Error("The library exceeds 5,000 searchable chunks. Reduce its size before indexing.");
          for (let offset = 0; offset < pieces.length; offset += 8) {
            this.progress(`Embedding ${note.title} (${offset + 1}/${pieces.length})`, index, state.notes.length);
            const batch = pieces.slice(offset, offset + 8);
            const vectors = await this.ollama.embed(model, batch.map((piece) => `search_document: ${note.title}\n${piece.sectionHeading ?? ""}\n${piece.text}`), signal);
            chunks.push(...batch.map((piece, i) => ({ ...piece, id: hash(`${note.id}:${fingerprint(note)}:${offset + i}`), noteId: note.id, title: note.title, folderId: note.folderId, vector: vectors[i] })));
          }
          document = { fingerprint: fingerprint(note), chunks, warning };
        }
        all.push(...document.chunks);
        if (all.length > 5000) throw new Error("The library exceeds 5,000 searchable chunks.");
        if (document.warning) warnings.push(document.warning);
        next.run("INSERT INTO documents VALUES (?, ?)", [note.id, JSON.stringify(document)]);
      }
      signal.throwIfAborted();
      if (libraryFingerprint(this.store.load()) !== libraryFingerprint(state)) throw new Error("Your notes changed while indexing. Ask again to use the latest version.");
      await atomicWrite(this.location, next.export());
      this.db.close(); this.db = next;
      return { chunks: all, warnings };
    } catch (error) { next.close(); throw error; }
  }
  async ask(input: RagRequest): Promise<RagReply> {
    const request = ragRequestSchema.parse(input);
    return this.exclusive(async (signal) => {
      const started = performance.now();
      let searchQuestion = request.question, rewritten = false, indexedChunks = 0, keywordCandidates = 0, vectorCandidates = 0;
      const reply = (answer: string, kind: RagReply["kind"], sources: RagReply["sources"] = [], warnings: string[] = []): RagReply => ({
        answer, kind, sources, warnings, indexedChunks,
        trace: { originalQuestion: request.question, searchQuestion, keywordQuery: keywordQuery(searchQuestion), rewritten, keywordCandidates, vectorCandidates, contextBytes: contextBytes(sources), elapsedMs: Math.round(performance.now() - started) },
      });
      this.progress("Checking local models");
      const models = await this.ollama.models(signal);
      if (!models.some((model) => model.name === request.chatModel && model.chat)) throw new Error("Choose an installed local chat model.");
      const embedding = models.find((model) => model.name === request.embeddingModel && model.embedding);
      if (!embedding) throw new Error("Install and select an embedding model, such as nomic-embed-text.");
      const state = this.store.load();
      if (request.folderId && !state.folders.some((folder) => folder.id === request.folderId)) throw new Error("That folder no longer exists.");
      this.progress("Understanding your question");
      const resolved = await resolveQuestion(this.ollama, request, signal);
      searchQuestion = resolved.question; rewritten = resolved.rewritten;
      if (resolved.clarification) return reply(resolved.clarification, "clarification");
      // Only the derived index is rebuilt. Notes, tasks, profile, and files are read-only here.
      const index = await this.sync(state, embedding.name, embedding.digest, signal);
      indexedChunks = index.chunks.length;
      const scoped = index.chunks.filter((chunk) => !request.folderId || chunk.folderId === request.folderId);
      if (!scoped.length) return reply("There is no searchable text in this scope yet. Add a written note, text document, or text-based PDF first.", "insufficient", [], index.warnings);
      this.progress("Searching your notes");
      const [vector] = await this.ollama.embed(embedding.name, [`search_query: ${searchQuestion}`], signal);
      const ranked = rankCandidates(scoped, searchQuestion, vector);
      keywordCandidates = ranked.keywordCount; vectorCandidates = ranked.vectorCount;
      // Source JSON has an exact byte budget. History never steals source space,
      // and the complete final prompt is checked again before generation.
      const budget = 6500 - promptBytes(request.question, searchQuestion, []);
      if (budget < 500) throw new Error("The question exceeds the local context budget. Try a shorter question.");
      const sources = selectContext(scoped, ranked.candidates, budget);
      if (!sources.length) return reply("I could not find passages that fit this question and the local context budget. Try a shorter, more specific question.", "insufficient", [], index.warnings);
      if (promptBytes(request.question, searchQuestion, sources) > 6500) throw new Error("The selected passages exceed the local context budget.");
      this.progress("Writing an answer from your sources");
      const response = z.object({ message: z.object({ content: z.string().max(50000) }), done_reason: z.string().optional() }).parse(await this.ollama.request("chat", {
        model: request.chatModel, stream: false, think: false, keep_alive: "0", format: answerFormat(sources, request.question),
        options: { temperature: 0.1, num_ctx: 8192, num_predict: 800 },
        messages: answerMessages(request.question, searchQuestion, sources),
      }, signal));
      signal.throwIfAborted();
      if (libraryFingerprint(this.store.load()) !== libraryFingerprint(state)) throw new Error("Your notes changed while answering. Ask again for an up-to-date answer.");
      const checked = checkedAnswer(response.message.content, sources, answerLimit(request.question));
      const warnings = [...index.warnings, ...checked.warnings];
      if (response.done_reason === "length") warnings.push("The answer reached its output limit and may be incomplete.");
      return reply(checked.answer, checked.kind, sources, warnings);
    });
  }
  close() { this.cancel(); this.db?.close(); }
}
