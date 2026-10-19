// Run with release/win-unpacked/NoteLah.exe and ELECTRON_RUN_AS_NODE=1.
// Loads the shipped modules/assets; never opens the user's workspace.
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { textPDF } = require('./chat-qa.cjs');
const resources = path.resolve('release/win-unpacked/resources');
const packed = path.join(resources, 'app.asar', 'desktop-dist');
const { DatabaseStore } = require(path.join(packed, 'electron/database.js'));
const { RagService } = require(path.join(packed, 'electron/rag.js'));
const { Ollama } = require(path.join(packed, 'electron/ollama.js'));

class FixtureOllama extends Ollama {
  async models() { return [{ name: 'chat', digest: 'fixture-chat', chat: true, embedding: false }, { name: 'embed', digest: 'fixture-embed', chat: false, embedding: true }]; }
  async embed(_model, texts) { return texts.map(() => [1, 0]); }
  async request() { return { message: { content: JSON.stringify({claims: [{text: 'Submit a working prototype and slide deck.', sources: [1]}, {text: 'The deadline is Friday at noon.', sources: [2]}], kind: 'answer'}) } }; }
}
(async () => {
  const root = path.resolve('work', `packed-chat-${crypto.randomUUID()}`);
  const store = new DatabaseStore(root); let rag;
  try {
    await store.initialize(path.join(resources, 'sql-wasm.wasm'));
    const pdf = path.join(root, 'packed.pdf'); await fs.writeFile(pdf, textPDF()); await store.importFiles([pdf], null);
    rag = new RagService(store, new FixtureOllama()); await rag.initialize(path.join(resources, 'sql-wasm.wasm'));
    const reply = await rag.ask({ question: 'What must SDC submit and when?', folderId: null, chatModel: 'chat', embeddingModel: 'embed', history: [] });
    assert.deepEqual(reply.warnings, []); assert.equal(reply.sources.length, 2);
    assert.deepEqual(new Set(reply.sources.map(source => source.page)), new Set([1, 2]));
    assert.match(reply.answer, /prototype/);
    assert.ok((await fs.stat(path.join(root, 'search-index.sqlite'))).size > 0);
    console.log('Packaged RAG smoke test passed: shipped PDF.js, font resources, worker, SQLite WASM, extraction, retrieval, and citations. Generation was stubbed; real models were tested in desktop QA.');
  } finally {
    rag?.close(); store.close(); assert.ok(root.startsWith(path.resolve('work') + path.sep)); await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
