const { _electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { textPDF } = require('./chat-qa.cjs');

(async () => {
  const root = path.resolve('work', `pdf-viewer-qa-${crypto.randomUUID()}`);
  await fs.mkdir(root, { recursive: true }); await fs.mkdir('work/screenshots', { recursive: true });
  const fixture = path.join(root, 'document.pdf');
  if (process.argv[2]) await fs.copyFile(path.resolve(process.argv[2]), fixture);
  else await fs.writeFile(fixture, textPDF());
  const env = { ...process.env, NOTELAH_TEST_DATA_DIR: path.join(root, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await page.getByText('All changes saved', { exact: true }).waitFor();
    assert.equal(path.resolve((await page.evaluate(() => window.notelah.load())).info.location), path.join(root, 'data', 'notelah.sqlite'), 'Refuse to edit a workspace outside this isolated QA directory');
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, fixture);
    const id = await page.evaluate(async () => (await window.notelah.importNotes(null)).state.notes[0].id);
    await fs.unlink(fixture);
    const opened = app.waitForEvent('window');
    await page.evaluate(id => window.notelah.openNoteFile(id), id);
    const viewer = await opened; await viewer.waitForLoadState();
    await viewer.waitForTimeout(1200);
    const pdfFrame = viewer.frames().find(frame => frame.url().startsWith('chrome-extension://'));
    assert.ok(pdfFrame, 'Built-in PDF viewer must load');
    await pdfFrame.locator('pdf-viewer').waitFor();
    await pdfFrame.waitForFunction(() => document.querySelector('pdf-viewer')?.loadState_ === 'success');
    const loaded = await pdfFrame.evaluate(() => document.querySelector('pdf-viewer').initialLoadComplete_);
    assert.equal(loaded, true, 'The PDF must finish loading, not just open a window');
    assert.equal(await viewer.evaluate(() => typeof window.notelah), 'undefined');
    const before = app.windows().length;
    await page.evaluate(id => window.notelah.openNoteFile(id), id);
    assert.equal(app.windows().length, before, 'Opening an already open PDF reuses its window');
    await viewer.screenshot({ path: 'work/screenshots/pdf-open-verified.png' });
    await viewer.close();
    console.log('PDF viewer QA passed: imported copy opens after removing its source, internal PDF viewer loads, no app bridge is exposed, and repeat opening reuses its window. User workspace was isolated.');
  } finally {
    await app.close(); assert.ok(root.startsWith(path.resolve('work') + path.sep)); await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
