import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = new URL('../', import.meta.url).pathname;
const patch = (file, oldValue, newValue) => `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${oldValue}\n+${newValue}\n`;
const mr = { id: 77, iid: 7, title: 'Keep review state stable', description: 'A mocked review.', state: 'opened', web_url: 'https://gitlab.example/group/app/-/merge_requests/7', source_branch: 'feature', target_branch: 'main', sha: 'head1', source_project_id: 2, target_project_id: 2, author: { username: 'reviewer', name: 'Reviewer' } };
let currentMrSha = 'head1';
let remoteDraftText = 'Remote GitLab draft';
const data = () => ({
  mr: { ...mr, sha: currentMrSha }, user: { id: 5, username: 'reviewer', name: 'Reviewer' }, project: { id: 2, path: 'group/app' },
  diffs: [
    { old_path: 'src/a.ts', new_path: 'src/a.ts', diff: patch('src/a.ts', 'const oldA = 1;', 'const newA = 2;'), new_file: false, deleted_file: false, renamed_file: false, identity: 'blob-a' },
    { old_path: 'src/b.ts', new_path: 'src/b.ts', diff: patch('src/b.ts', 'const oldB = 1;', 'const newB = 2;'), new_file: false, deleted_file: false, renamed_file: false, identity: 'blob-b' },
  ], discussions: [], draftNotes: [{ id: 31, note: remoteDraftText, position: null }, { id: 32, note: 'Delete this draft', position: null }],
  codeowners: [{ pattern: 'src/a.ts', owners: ['reviewer'] }, { pattern: 'src/b.ts', owners: ['other'] }], ownerStatus: { reviewer: true, other: false },
});
async function availablePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('review screen preserves preview navigation and local drafts while reviewing files', { timeout: 120_000 }, async t => {
  const port = await availablePort();
  const nuxtCli = fileURLToPath(new URL('../node_modules/nuxt/bin/nuxt.mjs', import.meta.url));
  const child = spawn(process.execPath, [nuxtCli, 'dev', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    detached: process.platform !== 'win32',
  });
  const serverLogs = [];
  child.stdout.on('data', value => serverLogs.push(value.toString()));
  child.stderr.on('data', value => serverLogs.push(value.toString()));
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5_000))]);
    if (!stopped) {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      await exited;
    }
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { const response = await fetch(baseUrl); if (response.ok) { ready = true; break; } } catch { /* dev server is compiling */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(ready, true, 'Nuxt dev server should start');
  await new Promise(resolve => setTimeout(resolve, 2_000));

  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  const errors = [];
  page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  const apiCalls = [];
  let previewLoads = 0;
  let publishedDrafts = false;
  let publishCalls = 0;
  let deleteCalls = 0;
  let failDraftDeleteOnce = true;
  const deletedDrafts = new Set();
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/api/gitlab', async route => {
    const request = route.request().postDataJSON();
    apiCalls.push(request.action);
    if (request.action === 'delete-draft-note') {
      deleteCalls++;
      if (failDraftDeleteOnce) {
        failDraftDeleteOnce = false;
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusMessage: 'Draft delete failed' }) });
        return;
      }
      deletedDrafts.add(request.payload.draftNoteId);
    }
    if (request.action === 'edit-draft-note') remoteDraftText = request.payload.note;
    const result = request.action === 'bootstrap' ? data()
      : request.action === 'refresh' ? { mr: { ...mr, sha: currentMrSha }, discussions: [], draftNotes: publishedDrafts ? [] : data().draftNotes.filter(note => !deletedDrafts.has(note.id)) }
      : request.action === 'preview' ? { previews: [{ url: 'https://preview.example/app', environment: 'qa-feature', match: 'exact', stale: false }] }
      : request.action === 'comment' ? { id: 1 }
      : request.action === 'delete-draft-note' || request.action === 'edit-draft-note' ? {}
      : request.action === 'publish-drafts' ? (publishCalls++, await new Promise(resolve => setTimeout(resolve, 150)), publishedDrafts = true, {})
      : request.action === 'open-preview' ? { url: request.payload.url }
      : {};
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await context.route('https://preview.example/**', async route => {
    previewLoads++;
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Mock preview</title><p>Preview body</p>' });
  });
  const url = `${baseUrl}/?mr=${encodeURIComponent('https://gitlab.example/group/app/-/merge_requests/7')}`;
  await page.goto(url);
  try { await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 1, undefined, { timeout: 15_000 }); }
  catch { throw new Error(`Review files did not load. DOM: ${(await page.locator('body').innerText()).slice(0, 500)}. Browser errors: ${errors.join('; ')}. Server logs: ${serverLogs.slice(-8).join('')}`); }
  assert.equal(await page.locator('iframe').count(), 0, 'preview is closed by default');
  assert.equal(await page.locator('.reviewed-mark').count(), 0, 'opening the first file must not mark it reviewed');
  assert.equal(await page.getByText('0/2 reviewed').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).count(), 1);
  assert.equal(await page.getByText('Remote GitLab draft').count(), 1, 'GitLab drafts have a separate display');
  assert.equal(await page.locator('.file-row').count(), 1, 'Only my files filters by confirmed CODEOWNERS membership');
  await page.getByRole('checkbox', { name: 'Only my files' }).uncheck();
  assert.equal(await page.locator('.file-row').count(), 2, 'disabling the owner filter restores all files');
  await page.getByRole('checkbox', { name: 'Only my files' }).check();
  assert.equal(await page.locator('.file-row').count(), 1);
  await page.getByRole('checkbox', { name: 'Only my files' }).uncheck();
  await page.locator('.file-row').nth(1).click();
  assert.equal(await page.locator('.reviewed-mark').count(), 0, 'navigating must not mark a file reviewed');
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  assert.equal(await page.getByText('1/2 reviewed').count(), 1);
  currentMrSha = 'head2';
  await page.getByRole('button', { name: '↻ Refresh' }).click();
  assert.equal(await page.getByText('1/2 reviewed').count(), 1, 'review status survives MR updates when the file identity is unchanged');
  await page.reload();
  await page.getByRole('checkbox', { name: 'Only my files' }).uncheck();
  await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 2);
  assert.equal(await page.getByText('1/2 reviewed').count(), 1, 'reviewed status survives a browser restart when file identity is unchanged');
  assert.equal(await page.getByRole('checkbox', { name: 'Auto-advance to next unreviewed file' }).isChecked(), false);
  await page.getByRole('checkbox', { name: 'Auto-advance to next unreviewed file' }).check();
  await page.locator('.file-row').nth(1).click();
  await page.getByRole('button', { name: 'Mark unreviewed', exact: true }).click();
  assert.equal(await page.getByText('0/2 reviewed').count(), 1);
  await page.locator('.file-row').nth(0).click();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  assert.equal(await page.getByText('1/2 reviewed').count(), 1);
  assert.equal(await page.locator('.path-label strong').innerText(), 'src/b.ts', 'auto-advance selects the next unreviewed file');
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  assert.equal(await page.getByText('2/2 reviewed').count(), 1);
  await page.getByRole('button', { name: 'Mark unreviewed', exact: true }).click();
  assert.equal(await page.getByText('1/2 reviewed').count(), 1);
  const draftEdit = page.getByRole('button', { name: 'Edit draft note 31' });
  assert.equal(await draftEdit.count(), 1, 'existing GitLab draft notes can be edited');
  await page.getByRole('button', { name: 'Delete draft note 32' }).click();
  assert.match(await page.getByRole('alert').innerText(), /Draft delete failed/, 'failed GitLab operations are shown to the reviewer');
  await page.getByRole('button', { name: 'Delete draft note 32' }).click();
  assert.equal(deleteCalls, 2, 'a failed request can be deliberately retried without duplicating its first success');
  await draftEdit.click();
  await page.getByLabel('Edit GitLab draft note').fill('Locally edited pending note');
  await page.locator('.file-row').nth(1).click();
  await page.getByRole('button', { name: '↻ Refresh' }).click();
  await page.reload();
  await page.getByRole('checkbox', { name: 'Only my files' }).uncheck();
  await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 2);
  await page.getByRole('button', { name: 'Edit draft note 31' }).click();
  assert.equal(await page.getByLabel('Edit GitLab draft note').inputValue(), 'Locally edited pending note', 'unsent draft-note edits persist through navigation, refresh and reload');
  await page.getByRole('button', { name: 'Save draft note' }).click();
  await page.getByRole('button', { name: 'Publish drafts (1)' }).dblclick();
  assert.equal(publishCalls, 1, 'double-click cannot publish the same draft batch twice');
  await page.waitForFunction(() => document.querySelector('.draft-notes')?.textContent?.includes('No GitLab draft notes') ?? false);
  assert.ok(apiCalls.includes('edit-draft-note'));
  assert.ok(apiCalls.includes('publish-drafts'));
  await page.getByLabel('Add a file comment').locator('..').locator('textarea').fill('Keep this draft');
  await page.getByRole('button', { name: '↻ Refresh' }).click();
  await page.locator('.file-row').nth(1).click();
  await page.locator('.file-row').nth(0).click();
  assert.equal(await page.locator('#review-comment').inputValue(), 'Keep this draft', 'unsent text returns with its file');
  await page.reload();
  await page.getByRole('checkbox', { name: 'Only my files' }).uncheck();
  await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 2);
  assert.equal(await page.locator('#review-comment').inputValue(), 'Keep this draft', 'unsent text survives a reload');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const iframe = page.locator('iframe[title="Merge request preview"]');
  await iframe.waitFor();
  await page.waitForTimeout(250);
  const initialLoads = previewLoads;
  assert.ok(initialLoads > 0, 'preview should load the matched deployment');
  await page.locator('.file-row').nth(1).click();
  await page.getByRole('button', { name: '↻ Refresh' }).click();
  await page.waitForTimeout(250);
  assert.equal(await iframe.getAttribute('src'), 'https://preview.example/app');
  assert.equal(previewLoads, initialLoads, 'file changes and discussion refresh must not navigate the preview');
  await page.waitForFunction(() => document.querySelector('diffs-container') !== null);
  await page.evaluate(() => {
    const root = document.querySelector('diffs-container');
    window.__diffRoot = root;
    window.__diffMutations = 0;
    window.__diffObserver = new MutationObserver(() => window.__diffMutations++);
    window.__diffObserver.observe(root.shadowRoot, { childList: true, subtree: true, attributes: true, characterData: true });
  });
  await page.getByRole('button', { name: '↻ Refresh' }).click();
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__diffMutations), 0, 'discussion polling leaves unchanged diff DOM untouched');
  assert.equal(await page.evaluate(() => window.__diffRoot === document.querySelector('diffs-container')), true);
  assert.ok(apiCalls.includes('refresh'));
  assert.deepEqual(errors, [], 'browser console should have no page exceptions');
  await context.close();
});
