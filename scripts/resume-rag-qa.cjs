// Uses a caller-selected complete backup ONLY as read-only input. All runtime
// writes go to a fresh work/ directory, checked before any restore or mutation.
const { _electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  if (!process.argv[2]) throw new Error('Pass the path to a complete NoteLah backup containing the resume.');
  const backup = path.resolve(process.argv[2]);
  const root = path.resolve('work', `resume-rag-qa-${crypto.randomUUID()}`);
  await fs.mkdir(root, { recursive: true }); await fs.mkdir('work/screenshots', { recursive: true });
  const env = { ...process.env, NOTELAH_TEST_DATA_DIR: path.join(root, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], env });
  let monitor;
  try {
    const page = await app.firstWindow();
    await page.getByText('All changes saved', { exact: true }).waitFor();
    assert.equal(path.resolve((await page.evaluate(() => window.notelah.load())).info.location), path.join(root, 'data', 'notelah.sqlite'));
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, backup);
    const restored = await page.evaluate(async () => { const preview = await window.notelah.selectRestore(); return window.notelah.restore(preview.token); });
    assert.equal(path.resolve(restored.info.location), path.join(root, 'data', 'notelah.sqlite'));
    // Capture model I/O only inside this isolated QA process for diagnosis.
    await app.evaluate(({ app }) => {
      const requireModule = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const { Ollama } = requireModule('./desktop-dist/electron/ollama.js');
      const original = Ollama.prototype.request;
      Ollama.prototype.request = async function (...args) { const response = await original.apply(this, args); if (args[0] === 'chat') globalThis.ragQaResponse = { request: args[1], response }; return response; };
    });
    const resume = restored.state.notes.find(note => note.file?.extension === 'pdf'); assert.ok(resume);
    await page.reload(); await page.getByText('All changes saved', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByLabel('Answer model', { exact: true }).selectOption('qwen3.5:2b-q4_K_M');
    await page.getByLabel('Embedding model', { exact: true }).selectOption('nomic-embed-text:latest');
    if (resume.folderId) await page.getByLabel('Search in', { exact: true }).selectOption(resume.folderId);
    let previous = '';
    monitor = setInterval(async () => { try { const status = await page.evaluate(() => window.notelah.chatStatus()); if (status.busy && status.message !== previous) { console.log(status.message); previous = status.message; } } catch {} }, 1500);
    const answers = [];
    for (const [index, question] of ['What is my specialty?', 'What do I study?', 'Which university was that?', 'What is my passport number?'].entries()) {
      await page.getByLabel('Ask your notes', { exact: true }).fill(question);
      await page.getByRole('button', { name: 'Ask', exact: true }).click();
      const turn = page.locator('.chat-turn').nth(index);
      await turn.locator('.chat-answer-text, .chat-error').waitFor({ timeout: 240000 });
      assert.equal(await turn.locator('.chat-error').count(), 0, await turn.textContent());
      const answer = await turn.locator('.chat-answer-text').innerText();
      const kind = await turn.locator('.chat-answer > span').innerText();
      await fs.writeFile('work/resume-rag-debug.json', JSON.stringify(await app.evaluate(() => globalThis.ragQaResponse), null, 2));
      answers.push({ question, answer, kind }); console.log(JSON.stringify(answers.at(-1)));
      if (index === 0) { assert.match(kind, /Inferred|From your notes/); assert.doesNotMatch(answer, /cannot find a specific answer.*specialty/i); assert.match(answer, /\[\d+\]/); }
      if (index === 1) {
        assert.match(answer, /Information Systems/i); assert.match(answer, /Intelligent Systems Engineering/i); assert.match(answer, /\[\d+\]/);
        const details = await turn.locator('.chat-sources').first().textContent();
        assert.match(details, /What do I study\?/); assert.match(details, /independently/); assert.doesNotMatch(details, /What is my specialty/);
        assert.match(await turn.textContent(), /Education/);
        const cited = [...answer.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]));
        const passages = await turn.locator('.chat-source').evaluateAll(elements => elements.map(element => ({ label: Number(/^\[(\d+)\]/.exec(element.querySelector('button').textContent.trim())?.[1]), text: element.querySelector('p').textContent })));
        assert.ok(passages.some(passage => cited.includes(passage.label) && /Bachelor of Information Systems/i.test(passage.text)), 'The degree claim must cite its qualification passage');
        await page.screenshot({ path: 'work/screenshots/resume-rag-improved.png', fullPage: true });
      }
      if (index === 2) { assert.match(kind, /From your notes/); assert.match(answer, /university|universiti|UiTM/i); assert.match(await turn.textContent(), /follow-up reference was resolved/); }
      if (index === 3) assert.match(kind, /Not enough evidence/);
    }
    await fs.writeFile('work/resume-rag-qa-result.json', JSON.stringify({ testedAt: new Date().toISOString(), answers }, null, 2));
    console.log('Resume RAG QA passed: specialty, independent study question, resolved follow-up, source sections, and abstention. Original workspace was untouched.');
  } finally {
    clearInterval(monitor); await app.close(); assert.ok(root.startsWith(path.resolve('work') + path.sep)); await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
