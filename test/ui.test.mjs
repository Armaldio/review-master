import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const root = new URL('../', import.meta.url).pathname;
const patch = (file, oldValue, newValue) => `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${oldValue}\n+${newValue}\n`;
const mr = { id: 77, iid: 7, title: 'Keep review state stable', description: 'A mocked review.', state: 'opened', web_url: 'https://gitlab.example/group/app/-/merge_requests/7', source_branch: 'feature', target_branch: 'main', sha: 'head1', source_project_id: 2, target_project_id: 2, author: { username: 'reviewer', name: 'Reviewer' } };
const data = () => ({
  mr, user: { id: 5, username: 'reviewer', name: 'Reviewer' }, project: { id: 2, path: 'group/app' },
  diffs: [
    { old_path: 'src/a.ts', new_path: 'src/a.ts', diff: patch('src/a.ts', 'const oldA = 1;', 'const newA = 2;'), new_file: false, deleted_file: false, renamed_file: false, identity: 'blob-a' },
    { old_path: 'src/b.ts', new_path: 'src/b.ts', diff: patch('src/b.ts', 'const oldB = 1;', 'const newB = 2;'), new_file: false, deleted_file: false, renamed_file: false, identity: 'blob-b' },
  ], discussions: [], codeowners: [],
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
  const child = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const serverLogs = [];
  child.stdout.on('data', value => serverLogs.push(value.toString()));
  child.stderr.on('data', value => serverLogs.push(value.toString()));
  let browser;
  t.after(async () => { if (browser) await browser.close(); child.kill('SIGTERM'); });
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
  const errors = [];
  page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  const apiCalls = [];
  let previewLoads = 0;
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/api/gitlab', async route => {
    const request = route.request().postDataJSON();
    apiCalls.push(request.action);
    const result = request.action === 'bootstrap' ? data()
      : request.action === 'refresh' ? { mr, discussions: [] }
      : request.action === 'preview' ? { previews: [{ url: 'https://preview.example/app', environment: 'qa-feature', match: 'exact', stale: false }] }
      : request.action === 'comment' ? { id: 1 }
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
  try { await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 2, undefined, { timeout: 15_000 }); }
  catch { throw new Error(`Review files did not load. DOM: ${(await page.locator('body').innerText()).slice(0, 500)}. Browser errors: ${errors.join('; ')}. Server logs: ${serverLogs.slice(-8).join('')}`); }
  assert.equal(await page.locator('iframe').count(), 0, 'preview is closed by default');
  await page.getByLabel('Add a file comment').locator('..').locator('textarea').fill('Keep this draft');
  await page.locator('.file-row').nth(1).click();
  await page.locator('.file-row').nth(0).click();
  assert.equal(await page.locator('#review-comment').inputValue(), 'Keep this draft', 'unsent text returns with its file');
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
  assert.ok(apiCalls.includes('refresh'));
  assert.deepEqual(errors, [], 'browser console should have no page exceptions');
  await context.close();
});
