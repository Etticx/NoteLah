const { _electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

function textPDF() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const text of ['SDC Hackathon teams must submit a working prototype and a slide deck.', 'The SDC Hackathon submission deadline is Friday at noon.']) { const stream = `BT /F1 12 Tf 40 700 Td (${text}) Tj ET`; objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); }
  let pdf = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
}

module.exports = { textPDF };
if (require.main === module) (async () => {
  const root = path.resolve('work', `chat-qa-${crypto.randomUUID()}`);
  await fs.mkdir(root, { recursive: true }); await fs.mkdir('work/screenshots', { recursive: true });
  const env = { ...process.env, NOTELAH_TEST_DATA_DIR: path.join(root, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], env });
  const errors = []; let monitor;
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1240, height: 900 });
    await page.getByText('All changes saved', { exact: true }).waitFor();
    const fixture = await page.evaluate(async () => {
      const { state } = await window.notelah.load(); const now = new Date().toISOString();
      const folder = { id: crypto.randomUUID(), name: 'SDC Hackathon', createdAt: now, updatedAt: now };
      state.folders.push(folder); state.notes.push({ id: crypto.randomUUID(), title: 'Unrelated personal note', body: 'Dinner groceries are apples and rice.', file: null, folderId: null, createdAt: now, updatedAt: now });
      await window.notelah.save(state); return { folderId: folder.id };
    });
    const pdf = path.join(root, 'SDC requirements.pdf'); await fs.writeFile(pdf, textPDF());
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, pdf);
    await page.evaluate(async folder => { await window.notelah.importNotes(folder); }, fixture.folderId);
    await fs.unlink(pdf);
    await page.reload(); await page.getByText('All changes saved', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByLabel('Answer model', { exact: true }).selectOption('qwen3.5:2b-q4_K_M', { timeout: 30000 });
    await page.getByLabel('Embedding model', { exact: true }).selectOption('nomic-embed-text:latest');
    await page.getByLabel('Search in', { exact: true }).selectOption(fixture.folderId);
    await page.getByLabel('Ask your notes', { exact: true }).fill('What must the SDC Hackathon team submit, and when is the deadline?');
    let previous = '';
    monitor = setInterval(async () => { try { const status = await page.evaluate(() => window.notelah.chatStatus()); if (status.busy && status.message !== previous) { console.log(status.message); previous = status.message; } } catch {} }, 1500);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.locator('.chat-answer-text').waitFor({ timeout: 240000 });
    const answer = await page.locator('.chat-answer-text').innerText();
    console.log('Live Qwen answer:', answer);
    assert.match(answer, /prototype/i); assert.match(answer, /Friday/i); assert.match(answer, /\[\d+\]/);
    await page.getByText('Retrieved passages (2)', { exact: true }).click();
    assert.equal(await page.locator('.chat-source').count(), 2);
    assert.ok((await page.locator('.chat-source').allTextContents()).every(text => text.includes('SDC requirements.pdf')));
    await page.locator('.chat-citation').first().click(); await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByText(/PDF page/).waitFor();
    await page.keyboard.press('Escape');
    await page.screenshot({ path: 'work/screenshots/chat-rag.png', fullPage: true });
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    assert.equal(await page.locator('.chat-answer-text').count(), 1);
    await page.setViewportSize({ width: 900, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByLabel('Ask your notes', { exact: true }).fill('Give a summary of the requirements.');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.locator('.chat-turn .chat-error').waitFor({ timeout: 15000 });
    assert.deepEqual(errors, []);
    assert.ok((await fs.stat(path.join(root, 'data', 'search-index.sqlite'))).size > 0);
    console.log('Chat QA passed: real Qwen + nomic embeddings, PDF extraction/page citations, folder scope, source opening, session retention, narrow layout, cancellation, and persistent index. Real user data was isolated.');
  } finally {
    clearInterval(monitor); await app.close();
    assert.ok(root.startsWith(path.resolve('work') + path.sep)); await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
