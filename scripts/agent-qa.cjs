// Uses synthetic data in a guarded test directory, never the real workspace.
const { _electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve('work', `agent-qa-${crypto.randomUUID()}`);
  await fs.mkdir(root, { recursive: true }); await fs.mkdir('work/screenshots', { recursive: true });
  const env = { ...process.env, NOTELAH_TEST_DATA_DIR: path.join(root, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], env });
  let monitor; const errors = [];
  try {
    const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
    await page.getByText('All changes saved', { exact: true }).waitFor();
    assert.equal(path.resolve((await page.evaluate(() => window.notelah.load())).info.location), path.join(root, 'data', 'notelah.sqlite'), 'Refuse to edit any non-isolated workspace');
    const original = await page.evaluate(async () => {
      const { state } = await window.notelah.load(); const now = new Date().toISOString();
      state.profile.name = 'Synthetic QA';
      state.tasks = ['Build hackathon prototype', 'Prepare hackathon slides', 'Buy groceries'].map(title => ({ id: crypto.randomUUID(), title, note: 'Synthetic example', plannedDate: null, completedAt: null, createdAt: now, updatedAt: now }));
      state.notes.push({ id: crypto.randomUUID(), title: 'Hackathon brief', body: 'The hackathon team must prepare a working prototype and slides. Work on the prototype before the slides.', folderId: null, file: null, createdAt: now, updatedAt: now });
      await window.notelah.save(state); return state;
    });
    await page.reload(); await page.getByText('All changes saved', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByLabel('Answer model', { exact: true }).selectOption('qwen3.5:2b-q4_K_M', { timeout: 30000 });
    await page.getByLabel('Embedding model', { exact: true }).selectOption('nomic-embed-text:latest');
    await page.getByLabel('Chat mode', { exact: true }).selectOption('plan');
    await page.getByLabel('Plan date', { exact: true }).fill('2026-10-20');
    await page.getByLabel('Available minutes', { exact: true }).fill('60');
    await page.getByLabel('Ask your notes', { exact: true }).fill('List my tasks and search my hackathon notes. Propose a 60-minute plan for the hackathon prototype and slides.');
    let last = '';
    monitor = setInterval(async () => { try { const s = await page.evaluate(() => window.notelah.chatStatus()); if (s.message !== last) { last = s.message; console.log(last); } } catch {} }, 1500);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector('.agent-plan') || !!document.querySelector('.chat-turn .chat-error'), null, { timeout: 240000 });
    const failure = await page.locator('.chat-turn .chat-error').allTextContents(); assert.deepEqual(failure, [], failure.join('\n'));
    console.log('Planning response:', await page.locator('.agent-plan').innerText());
    await page.getByRole('button', { name: 'Apply plan', exact: true }).waitFor({ timeout: 10000 });
    assert.deepEqual((await page.evaluate(() => window.notelah.load())).state, original, 'Proposal must not mutate data');
    const activity = await page.locator('.agent-plan').innerText();
    console.log('Agent proposal:', activity.slice(0, 1500));
    assert.match(activity, /prototype/i);
    await page.getByText(/Agent activity/).click();
    assert.match(await page.locator('.agent-plan').innerText(), /list_tasks/);
    assert.match(await page.locator('.agent-plan').innerText(), /search_notes/);
    await page.screenshot({ path: 'work/screenshots/agent-plan.png', fullPage: true });
    await page.getByRole('button', { name: 'Apply plan', exact: true }).click();
    await page.getByRole('button', { name: 'Undo plan', exact: true }).waitFor();
    const applied = (await page.evaluate(() => window.notelah.load())).state;
    assert.ok(applied.tasks.some(t => t.plannedDate === '2026-10-20'));
    assert.deepEqual(applied.notes, original.notes); assert.deepEqual(applied.profile, original.profile);
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: 'Undo plan', exact: true }).click();
    await page.getByText('Original planned dates restored.', { exact: true }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.notelah.load())).state, original);
    await page.setViewportSize({ width: 900, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByLabel('Ask your notes', { exact: true }).fill('Plan my work again.');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByRole('button', { name: 'Ask', exact: true }).waitFor({ timeout: 30000 });
    assert.deepEqual((await page.evaluate(() => window.notelah.load())).state, original);
    assert.deepEqual(errors, []);
    console.log('Agent UI QA passed: live local tools, review, apply, navigation, undo, narrow layout, Stop, and isolated data.');
  } finally { clearInterval(monitor); await app.close(); assert.ok(root.startsWith(path.resolve('work') + path.sep)); await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
