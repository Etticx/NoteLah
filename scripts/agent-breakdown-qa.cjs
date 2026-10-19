// Goal-breakdown regression: synthetic, path-verified workspace; real local Qwen.
const { _electron } = require('playwright-core');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const question = 'so can u list down if i wanna research about my SDC hackathon project, what task i need to do? i have 2 domains im on second domain and has many SDG tracks';
(async () => {
  const root = path.resolve('work', 'agent-breakdown-qa-' + crypto.randomUUID());
  await fs.mkdir(root, { recursive: true }); await fs.mkdir('work/screenshots', { recursive: true });
  const env = { ...process.env, NOTELAH_TEST_DATA_DIR: path.join(root, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], env }); let monitor;
  try {
    const page = await app.firstWindow(); await page.getByText('All changes saved', { exact: true }).waitFor();
    assert.equal(path.resolve((await page.evaluate(() => window.notelah.load())).info.location), path.join(root, 'data', 'notelah.sqlite'), 'Refuse non-isolated data');
    const original = await page.evaluate(async () => {
      const { state } = await window.notelah.load(), now = new Date().toISOString();
      state.tasks = [{ id: crypto.randomUUID(), title: 'Buy groceries', note: 'Keep this unrelated task unchanged', plannedDate: null, completedAt: null, createdAt: now, updatedAt: now }];
      state.profile.name = 'Synthetic breakdown QA'; await window.notelah.save(state); return state;
    });
    await page.reload(); await page.getByText('All changes saved', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByLabel('Answer model', { exact: true }).selectOption('qwen3.5:2b-q4_K_M', { timeout: 30000 });
    await page.getByLabel('Embedding model', { exact: true }).selectOption('nomic-embed-text:latest');
    // Reproduce the screenshot in the existing mode; it must route to a draft rather than refuse or reschedule groceries.
    await page.getByLabel('Chat mode', { exact: true }).selectOption('plan');
    await page.getByLabel('Ask your notes', { exact: true }).fill(question);
    let last = ''; monitor = setInterval(async () => { try { const s = await page.evaluate(() => window.notelah.chatStatus()); if (s.message !== last) { last = s.message; console.log(last); } } catch {} }, 1500);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector('.agent-plan') || !!document.querySelector('.chat-turn .chat-error'), null, { timeout: 210000 });
    console.log('Goal breakdown:', await page.locator('.chat-turn').innerText());
    assert.doesNotMatch(await page.locator('.agent-plan').innerText(), /120[ -]*minute/i, 'A goal checklist must not inherit the day-planner time budget');
    assert.match(await page.locator('.agent-plan').innerText(), /Focus on domain 2/);
    assert.doesNotMatch(await page.locator('.agent-items').innerText(), /both domains|two domains|each domain|per domain/i);
    await page.getByRole('button', { name: 'Add tasks', exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByRole('button', { name: 'Apply plan', exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Chat mode', { exact: true }).inputValue(), 'breakdown');
    assert.deepEqual((await page.evaluate(() => window.notelah.load())).state, original);
    const count = await page.locator('.agent-items li').count(); assert.ok(count >= 2 && count <= 6);
    await page.screenshot({ path: 'work/screenshots/agent-goal-breakdown.png', fullPage: true });
    await page.getByRole('button', { name: 'Add tasks', exact: true }).click();
    await page.getByRole('button', { name: 'Undo task additions', exact: true }).waitFor();
    const after = (await page.evaluate(() => window.notelah.load())).state;
    assert.deepEqual(after.tasks.slice(0, original.tasks.length), original.tasks);
    assert.equal(after.tasks.length, original.tasks.length + count);
    assert.ok(after.tasks.slice(original.tasks.length).every(t => t.plannedDate === null && !t.completedAt));
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /^Later/ }).click();
    await page.getByText(after.tasks[1].title, { exact: true }).filter({ visible: true }).waitFor();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: 'Undo task additions', exact: true }).click();
    await page.getByText('Added tasks removed.', { exact: true }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.notelah.load())).state, original);
    console.log('Goal breakdown QA passed: exact screenshot wording, live tools, new-task draft, approval, Later, undo, and unrelated tasks preserved.');
  } finally { clearInterval(monitor); await app.close(); assert.ok(root.startsWith(path.resolve('work') + path.sep)); await fs.rm(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exit(1); });
