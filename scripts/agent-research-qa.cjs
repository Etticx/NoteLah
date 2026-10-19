// Regression for a research request in Plan my day; synthetic, path-verified workspace only.
const { _electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const question = 'i wanna research about what to do on SDC Hackathon it has 2 theme, many track of SDG it must use replit and repod';
(async () => {
  const root = path.resolve('work', 'agent-research-qa-' + crypto.randomUUID());
  await fs.mkdir(root, { recursive: true }); await fs.mkdir('work/screenshots', { recursive: true });
  const env = { ...process.env, NOTELAH_TEST_DATA_DIR: path.join(root, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow(); await page.getByText('All changes saved', { exact: true }).waitFor();
    assert.equal(path.resolve((await page.evaluate(() => window.notelah.load())).info.location), path.join(root, 'data', 'notelah.sqlite'), 'Refuse non-isolated data');
    const original = await page.evaluate(async () => {
      const { state } = await window.notelah.load(), now = new Date().toISOString();
      state.tasks = [{ id: crypto.randomUUID(), title: 'Buy groceries', note: '', plannedDate: null, completedAt: null, createdAt: now, updatedAt: now }];
      state.profile.name = 'Synthetic research QA'; await window.notelah.save(state); return state;
    });
    await page.reload(); await page.getByText('All changes saved', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByLabel('Answer model', { exact: true }).selectOption('qwen3.5:2b-q4_K_M', { timeout: 30000 });
    await page.getByLabel('Embedding model', { exact: true }).selectOption('nomic-embed-text:latest');
    await page.getByLabel('Chat mode', { exact: true }).selectOption('plan');
    await page.getByLabel('Ask your notes', { exact: true }).fill(question);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector('.agent-plan') || !!document.querySelector('.chat-turn .chat-error'), null, { timeout: 210000 });
    console.log('Research response:', await page.locator('.chat-turn').innerText());
    await page.getByRole('button', { name: 'Ask my notes instead', exact: true }).waitFor({ timeout: 210000 });
    assert.equal(await page.getByRole('button', { name: 'Apply plan', exact: true }).count(), 0);
    assert.equal(await page.locator('.chat-turn .chat-error').count(), 0);
    console.log('Research scope clarification:', await page.locator('.agent-plan .chat-answer-text').innerText());
    assert.deepEqual((await page.evaluate(() => window.notelah.load())).state, original);
    await page.getByRole('button', { name: 'Ask my notes instead', exact: true }).click();
    assert.equal(await page.getByLabel('Chat mode', { exact: true }).inputValue(), 'notes');
    assert.equal(await page.getByLabel('Ask your notes', { exact: true }).inputValue(), question);

    // Force the model-format failure independent of model randomness. No real workspace involved.
    await app.evaluate(({ app }) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const { Ollama } = require(app.getAppPath() + '/desktop-dist/electron/ollama.js');
      const original = Ollama.prototype.request;
      Ollama.prototype.request = function(endpoint, ...args) { return endpoint === 'chat' ? Promise.resolve({ message: { content: '{"tool":"unknown"}' } }) : original.call(this, endpoint, ...args); };
    });
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByLabel('Chat mode', { exact: true }).selectOption('plan');
    await page.getByLabel('Ask your notes', { exact: true }).fill('Plan my day using my unfinished tasks.');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.getByRole('button', { name: 'Ask my notes instead', exact: true }).waitFor({ timeout: 30000 });
    assert.match(await page.locator('.agent-plan .chat-answer-text').innerText(), /couldn't prepare a valid day plan/);
    assert.equal(await page.locator('.chat-turn .chat-error').count(), 0);
    assert.deepEqual((await page.evaluate(() => window.notelah.load())).state, original);
    await page.screenshot({ path: 'work/screenshots/agent-research-fallback.png', fullPage: true });
    console.log('Research regression QA passed: scope clarification, safe format-failure recovery, mode switch, original question kept, no data changes.');
  } finally { await app.close(); assert.ok(root.startsWith(path.resolve('work') + path.sep)); await fs.rm(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exit(1); });
