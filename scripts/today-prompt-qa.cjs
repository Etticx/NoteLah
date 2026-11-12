// Today prompt regression: a goal typed on Today reaches the agent, and approval puts the tasks on Today. Real local Qwen.
const { _electron } = require('playwright-core');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const root = path.resolve('work', 'today-prompt-qa-' + crypto.randomUUID());
  await fs.mkdir(root, { recursive: true }); await fs.mkdir('work/screenshots', { recursive: true });
  const env = { ...process.env, NOTELAH_TEST_DATA_DIR: path.join(root, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow(); await page.getByText('All changes saved', { exact: true }).waitFor();
    const before = await page.evaluate(() => window.notelah.load());
    assert.equal(path.resolve(before.info.location), path.join(root, 'data', 'notelah.sqlite'), 'Refuse non-isolated data');
    await page.screenshot({ path: 'work/screenshots/today-prompt.png', fullPage: true });
    // Chat has never been opened, so this also covers waiting for the model list before sending.
    await page.getByRole('button', { name: 'Revise for my Database Systems exam', exact: true }).click();
    await page.getByRole('button', { name: 'Suggest tasks', exact: true }).click();
    await page.getByRole('heading', { name: /^Chat/ }).waitFor();
    await page.waitForFunction(() => !!document.querySelector('.agent-plan') || !!document.querySelector('.chat-turn .chat-error') || !!document.querySelector('.chat-error'), null, { timeout: 240000 });
    console.log('Reply:', (await page.locator('.chat-conversation').innerText()).slice(0, 600));
    assert.equal(await page.locator('.chat-turn').count(), 1, 'The goal must be sent exactly once');
    assert.equal(await page.getByLabel('Chat mode', { exact: true }).inputValue(), 'breakdown');
    const count = await page.locator('.agent-items li').count(); assert.ok(count >= 1 && count <= 6);
    await page.getByRole('button', { name: 'Add tasks', exact: true }).click();
    await page.getByRole('heading', { name: /^Today/ }).waitFor();
    const after = (await page.evaluate(() => window.notelah.load())).state;
    const day = await page.getByLabel('Choose a day', { exact: true }).inputValue();
    assert.equal(after.tasks.length, before.state.tasks.length + count);
    assert.ok(after.tasks.every(t => t.plannedDate === day && !t.completedAt));
    await page.locator('.task-title', { hasText: after.tasks[0].title }).waitFor();
    assert.equal(await page.locator('.task-row').count(), count);
    await page.screenshot({ path: 'work/screenshots/today-prompt-added.png', fullPage: true });
    console.log('Today prompt QA passed: hand-off, single send, approval, tasks on Today.');
  } finally { await app.close(); assert.ok(root.startsWith(path.resolve('work') + path.sep)); await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
