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
const { AgentService } = require(path.join(packed, 'electron/agent.js'));
const { createTask } = require(path.join(packed, 'src/lib/model.js'));

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
    const original = store.load(); original.tasks.push(createTask('Packaged agent task', null)); await store.save(original);
    const actions = [
      { tool: 'list_tasks', query: '', taskId: '', summary: '', items: [] },
      { tool: 'propose_plan', query: '', taskId: '', summary: 'Review packaged plan', items: [{ taskId: original.tasks[0].id, minutes: 25, reason: 'Start the task' }] },
    ];
    const planner = new FixtureOllama(); planner.request = async () => ({ message: { content: JSON.stringify(actions.shift()) } });
    const agent = new AgentService(store, rag, planner);
    const plan = await agent.plan({ question: 'Plan my day', date: '2026-10-20', minutes: 30, preference: '', history: [], folderId: null, chatModel: 'chat', embeddingModel: 'embed' });
    assert.deepEqual(store.load(), original);
    const applied = await agent.apply(plan.token); assert.equal(applied.state.tasks[0].plannedDate, '2026-10-20');
    assert.deepEqual(await agent.undo(applied.receipt.token), original); agent.clear();
    const draftActions = [
      { tool: 'list_tasks', query: '', summary: '', drafts: [], assumptions: [] },
      { tool: 'propose_tasks', query: '', summary: 'Suggested research steps', drafts: [{ title: 'Verify research requirements', note: 'Read the official brief.' }], assumptions: ['Requirements need verification.'] },
    ];
    planner.request = async () => ({ message: { content: JSON.stringify(draftActions.shift()) } });
    const draft = await agent.plan({ question: 'What tasks do I need for hackathon research?', intent: 'breakdown', date: '2026-10-20', minutes: 30, preference: '', history: [], folderId: null, chatModel: 'chat', embeddingModel: 'embed' });
    assert.equal(draft.kind, 'task_draft'); assert.deepEqual(store.load(), original);
    const added = await agent.apply(draft.token); assert.equal(added.state.tasks.length, original.tasks.length + 1); assert.equal(added.state.tasks.at(-1).plannedDate, null);
    assert.deepEqual(await agent.undo(added.receipt.token), original); agent.clear();
    for (const name of ['LICENSE', 'PRIVACY.md', 'DISCLAIMER.md', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.txt']) assert.ok((await fs.stat(path.join(resources, 'app.asar', name))).size > 0);
    console.log('Packaged smoke passed: RAG, agent scheduling and task creation, approval/undo, SQLite, PDF assets, and release documents. Generation stubbed; live models tested separately.');
  } finally {
    rag?.close(); store.close(); assert.ok(root.startsWith(path.resolve('work') + path.sep)); await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
