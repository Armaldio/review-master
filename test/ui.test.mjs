import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = new URL('../', import.meta.url).pathname;
const mr = { id: 77, iid: 7, title: 'Keep review state stable', description: 'A mocked review.\n\n![GitLab upload](https://gitlab.example/uploads/screenshot.png)\n\n![External image](https://attacker.invalid/track.png)', state: 'opened', web_url: 'https://gitlab.example/group/app/-/merge_requests/7', source_branch: 'feature', target_branch: 'main', sha: 'head1', diff_refs: { base_sha: 'base1', head_sha: 'head1', start_sha: 'base1' }, source_project_id: 2, target_project_id: 2, author: { username: 'reviewer', name: 'Reviewer' } };
let currentMrSha = 'head1';
const currentMr = () => ({ ...mr, sha: currentMrSha, diff_refs: { base_sha: `base-${currentMrSha}`, head_sha: currentMrSha, start_sha: `base-${currentMrSha}` } });
let includeFullFile = false;
let remoteDraftText = 'Remote GitLab draft';
let ownerMembershipKnown = true;
const data = () => ({
  mr: currentMr(), user: { id: 5, username: 'reviewer', name: 'Reviewer' }, project: { id: 2, path: 'group/app' },
  diffs: [
    { old_path: 'doc/releases/19/release.md', new_path: 'doc/releases/19/release.md', diff: '@@ -0,0 +1 @@\n+const newA = 2;\n', new_file: true, deleted_file: false, renamed_file: false, identity: 'blob-a' },
    { old_path: 'src/b.ts', new_path: 'src/b.ts', diff: '@@ -1 +1 @@\n-const oldB = 1;\n+const newB = 2;\n', new_file: false, deleted_file: false, renamed_file: false, identity: 'blob-b' },
    ...(includeFullFile ? [{ old_path: 'src/full.ts', new_path: 'src/full.ts', diff: '', old_id: 'old-full', new_id: 'new-full', new_file: false, deleted_file: false, renamed_file: false, too_large: true, identity: 'blob-full' }] : []),
  ], discussions: [{ id: 'thread-1', resolved: false, notes: [{ id: 41, body: 'Mock discussion', author: { id: 6, name: 'Reviewer' }, award_emoji: [] }] }], draftNotes: [{ id: 31, note: remoteDraftText, position: null }, { id: 32, note: 'Delete this draft', position: null }],
  codeowners: [{ pattern: 'releases/**/*.md', owners: ['reviewer', 'other'] }, { pattern: 'src/b.ts', owners: ['other'] }], ownerStatus: { reviewer: true, other: null },
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
  const externalImageRequests = [];
  let previewLoads = 0;
  let publishedDrafts = false;
  let publishCalls = 0;
  let delayFirstRefresh = true;
  let deleteCalls = 0;
const submittedComments = [];
  let failDraftDeleteOnce = true;
  let holdIdentityHydration = false;
  let releaseIdentityHydration = () => {};
  let identityRequestSignal;
  const deletedDrafts = new Set();
  page.on('pageerror', error => errors.push(error.message));
  await context.route('https://attacker.invalid/**', async route => {
    externalImageRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'image/png', body: '' });
  });
  await context.route('**/api/gitlab', async route => {
    const request = route.request().postDataJSON();
    apiCalls.push(request.action);
    if (request.action === 'file-identities' && holdIdentityHydration) {
      identityRequestSignal?.();
      identityRequestSignal = undefined;
      await new Promise(resolve => { releaseIdentityHydration = resolve; });
    }
    if (request.action === 'bootstrap') await new Promise(resolve => setTimeout(resolve, 1_500));
    if (request.action === 'refresh' && delayFirstRefresh) {
      delayFirstRefresh = false;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
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
    const result = request.action === 'bootstrap' ? { ...data(), diffs: data().diffs.map(file => ({ ...file, identity: file.deleted_file ? 'deleted' : null })), discussions: [], draftNotes: [] }
      : request.action === 'file-identities' ? { identities: Object.fromEntries(data().diffs.filter(file => request.payload.paths.includes(file.new_path)).map(file => [file.new_path, file.identity])) }
      : request.action === 'refresh' ? { mr: currentMr(), discussions: data().discussions, draftNotes: publishedDrafts ? [] : data().draftNotes.filter(note => !deletedDrafts.has(note.id)) }
      : request.action === 'verify-owners' ? { codeowners: data().codeowners, ownerStatus: ownerMembershipKnown ? { reviewer: true, other: null } : { reviewer: null, other: null } }
      : request.action === 'preview' ? { previews: [{ url: 'https://preview.example/app', environment: 'qa-feature', match: 'exact', stale: false }] }
      : request.action === 'comment' ? (submittedComments.push(request.payload), { id: 1 })
      : request.action === 'files' ? { content: request.payload.ref === 'head-full'
        ? Array.from({ length: 1_500 }, (_, index) => `export const full${index} = ${index === 749 ? 9999 : index};`).join('\n')
        : Array.from({ length: 1_500 }, (_, index) => `export const full${index} = ${index};`).join('\n') }
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
  await page.getByRole('status').getByText('Loading merge request…', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.url-form').count(), 0, 'the launch form is removed');
  assert.equal(await page.locator('.loading-spinner').count(), 1, 'the initial MR load shows a spinner');
  try {
    await page.waitForFunction(() => document.querySelectorAll('.file-row').length > 0, undefined, { timeout: 15_000 });
    assert.equal(await page.getByText('Remote GitLab draft').count(), 0, 'the initial file view renders before delayed discussion and draft hydration');
    const showAll = page.getByRole('checkbox', { name: 'Show all files' });
    assert.equal(await showAll.isChecked(), false, 'Only my files is the default review scope');
    await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 1, undefined, { timeout: 15_000 });
  } catch {
    throw new Error(`Review files did not load or CODEOWNERS filtering failed. Show all: ${await page.getByRole('checkbox', { name: 'Show all files' }).isChecked()}. Warning: ${await page.locator('.owner-warning').innerText().catch(() => 'none')}. DOM: ${(await page.locator('body').innerText()).slice(0, 500)}. Browser errors: ${errors.join('; ')}. Server logs: ${serverLogs.slice(-8).join('')}`);
  }
  assert.equal(await page.locator('iframe').count(), 0, 'preview is closed by default');
  assert.equal(await page.locator('.reviewed-mark').count(), 0, 'opening the first file must not mark it reviewed');
  assert.equal(await page.getByText('0/2 · 0%', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).count(), 1);
  ownerMembershipKnown = false;
  await page.locator('.action-menu summary').click();
  await page.getByRole('button', { name: 'Refresh memberships' }).click();
  await page.getByText('No files are visible in this owner scope. Use Show all files to review every changed file.', { exact: true }).waitFor();
  assert.equal(await page.getByText('No changed files were returned by GitLab.', { exact: true }).count(), 0, 'hidden files are not described as missing from GitLab');
  ownerMembershipKnown = true;
  await page.locator('.action-menu summary').click();
  await page.getByRole('button', { name: 'Refresh memberships' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 1);
  assert.equal(await page.locator('.file-row').first().innerText().then(text => text.includes('release.md')), true, 'a confirmed owner makes the file eligible even when another listed owner is unresolved');
  await page.getByRole('button', { name: 'Next unreviewed file' }).click();
  assert.equal(await page.locator('.path-label strong').innerText(), 'doc/releases/19/release.md', 'next-file navigation stays inside positively owned files');
  await page.getByLabel('Find a file').fill('src/');
  assert.equal(await page.locator('.file-row').count(), 0, 'search cannot reveal an unverified file');
  assert.equal(await page.locator('.path-label strong').count(), 0, 'the diff pane hides the previously selected file when search excludes it');
  await page.locator('.progress-segment').first().click();
  assert.equal(await page.getByLabel('Find a file').inputValue(), '', 'opening a visible progress segment clears a search that hid its file');
  assert.equal(await page.locator('.path-label strong').innerText(), 'doc/releases/19/release.md');
  await page.getByRole('button', { name: 'Use directory tree' }).click();
  assert.equal(await page.locator('.file-row').count(), 1, 'tree view uses the same owner filter');
  await page.getByRole('button', { name: 'Use flat list' }).click();
  await page.locator('.display-menu summary').click();
  await page.getByLabel('Continuous files').check();
  assert.equal(await page.locator('.continuous-file').count(), 1, 'continuous view includes only positively owned files');
  assert.equal(await page.locator('.continuous-file').first().getAttribute('data-path'), 'doc/releases/19/release.md');
  await page.getByLabel('Continuous files').uncheck();
  assert.equal(await page.locator('.progress-segment').count(), 2, 'the progress bar keeps one segment per changed file');
  assert.equal(await page.locator('.file-heading .review-toggle').count(), 1, 'the primary review action stays beside the filename');
  const segmentWidths = await page.locator('.progress-segment').evaluateAll(segments => segments.map(segment => segment.getBoundingClientRect().width));
  assert.ok(segmentWidths.every(width => width > 0), 'every file segment remains visible');
  const initialSegmentOpacity = await page.locator('.progress-segment').evaluateAll(segments => segments.map(segment => getComputedStyle(segment).opacity));
  assert.ok(initialSegmentOpacity.every(opacity => Number(opacity) < 1), 'unreviewed file segments are dimmed');
  assert.equal(await page.locator('.progress-segment').nth(1).isDisabled(), true, 'segments for unowned files cannot bypass the owner filter');
  await page.locator('.progress-segment').nth(1).click({ force: true });
  assert.equal(await page.locator('.path-label strong').innerText(), 'doc/releases/19/release.md', 'a filtered segment cannot change the active file');
  const showAll = page.getByRole('checkbox', { name: 'Show all files' });
  await showAll.check();
  await page.locator('.progress-segment').nth(1).click();
  assert.equal(await page.locator('.path-label strong').innerText(), 'src/b.ts', 'the explicit Show all toggle enables every segment');
  await showAll.uncheck();
  assert.equal(await page.locator('.path-label strong').innerText(), 'doc/releases/19/release.md', 'turning the owner filter back on moves review to an eligible file');
  await page.getByText('Remote GitLab draft').waitFor({ state: 'visible' });
  assert.equal(await page.getByText('Remote GitLab draft').count(), 1, 'GitLab drafts have a separate display');
  await page.locator('diffs-container').waitFor();
  assert.equal(await page.locator('diffs-container').count(), 1, 'GitLab hunk-only diffs render in Pierre, including new files');
  assert.match(await page.locator('diffs-container').evaluate(el => el.shadowRoot?.textContent || ''), /const newA = 2;/);
  assert.ok((await page.locator('.reaction').allTextContents()).includes('👍'), 'discussion reactions render as emoji');
  await page.setViewportSize({ width: 961, height: 892 });
  const toolbarLayout = await page.locator('.topbar').evaluate(el => {
    const heading = el.querySelector('.mr-heading').getBoundingClientRect();
    const actions = el.querySelector('.top-actions').getBoundingClientRect();
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, headingBottom: heading.bottom, actionsTop: actions.top };
  });
  assert.ok(toolbarLayout.scrollWidth <= toolbarLayout.clientWidth, 'header actions do not overflow at tablet width');
  assert.ok(toolbarLayout.actionsTop >= toolbarLayout.headingBottom - 1, 'header actions wrap to a separate row at tablet width');
  await page.setViewportSize({ width: 809, height: 768 });
  assert.equal(await page.getByRole('button', { name: 'Approve' }).isVisible(), true, 'the primary review action stays visible');
  assert.equal(await page.getByRole('button', { name: 'Request changes' }).isVisible(), false, 'secondary review actions stay out of the crowded header');
  assert.equal(await page.getByRole('button', { name: 'Unapprove' }).isVisible(), false, 'secondary state actions are tucked into More');
  await page.getByText('More (2)', { exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Request changes' }).isVisible(), true, 'request changes remains available from More');
  assert.equal(await page.getByRole('button', { name: 'Publish drafts (2)' }).isVisible(), true, 'secondary actions remain available from More');
  await page.getByText('More (2)', { exact: true }).click();
  await page.setViewportSize({ width: 600, height: 768 });
  await page.getByText('More (2)', { exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Publish drafts (2)' }).isVisible(), true, 'the action menu remains usable on narrow screens');
  await page.getByText('More (2)', { exact: true }).click();
  await page.setViewportSize({ width: 809, height: 768 });
  await page.getByRole('button', { name: 'Toggle light and dark theme' }).click();
  const selectedColors = await page.locator('.file-row.selected').evaluate(el => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, color: style.color };
  });
  assert.notEqual(selectedColors.background, 'rgb(238, 234, 251)', 'dark mode uses a dark selected-file background');
  await showAll.uncheck();
  assert.equal(await page.locator('.file-row').count(), 1, 'the default owner filter shows only positively verified ownership');
  await page.getByRole('button', { name: 'Details' }).click();
  assert.equal(externalImageRequests.length, 0, 'external Markdown images are removed before the browser can request them');
  assert.equal(await page.locator('.description img').count(), 1, 'same-host GitLab upload images remain proxied');
  assert.match(await page.locator('.description img').getAttribute('src'), /^\/api\/gitlab-image\?/);
  await page.getByRole('button', { name: 'Hide details' }).click();
  await showAll.check();
  assert.equal(await page.locator('.file-row').count(), 2, 'disabling the owner filter restores all files');
  await showAll.uncheck();
  assert.equal(await page.locator('.file-row').count(), 1);
  await showAll.check();
  await page.locator('.file-row').nth(1).click();
  assert.equal(await page.locator('.reviewed-mark').count(), 0, 'navigating must not mark a file reviewed');
  await page.waitForFunction(() => document.querySelector('.diff-shell')?.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]'));
  assert.match(await page.locator('diffs-container').evaluate(el => el.shadowRoot?.textContent || ''), /const newB = 2;/, 'GitLab hunk-only modified diffs render without a diff header');
  await page.locator('diffs-container').locator('[data-line]').first().click();
  await page.locator('#review-comment').fill('Comment draft survives a diff update');
  assert.match(await page.locator('.comment-form > label').innerText(), /Comment on selected diff line/);
  currentMrSha = 'head2';
  await page.getByRole('button', { name: '↻ Refresh' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.top-actions button')].some(button => button.textContent?.trim() === '↻ Refresh' && !button.disabled));
  assert.match(await page.locator('.comment-form > label').innerText(), /Add a file comment/, `a changed diff clears the stale line selection; actions: ${apiCalls.join(',')}`);
  assert.equal(await page.locator('#review-comment').inputValue(), 'Comment draft survives a diff update', 'clearing a stale line keeps the unsent text');
  await page.getByRole('checkbox', { name: 'Save as draft note' }).uncheck();
  await page.getByRole('button', { name: 'Post comment' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('Comment posted'));
  assert.equal(submittedComments.at(-1).position, undefined, 'a refreshed comment cannot submit old diff references');
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  const reviewedSegmentOpacity = await page.locator('.progress-segment').evaluateAll(segments => segments.map(segment => getComputedStyle(segment).opacity));
  assert.deepEqual(reviewedSegmentOpacity.sort(), ['0.5', '1'], 'reviewed segments are bright while unreviewed segments stay dimmed');
  assert.match(await page.locator('.progress-label').innerText(), /^1\/2 · \d+%$/);
  await page.getByRole('button', { name: '↻ Refresh' }).click();
  assert.match(await page.locator('.progress-label').innerText(), /^1\/2 · \d+%$/, 'review status survives MR updates when the file identity is unchanged');
  await page.reload();
  await page.getByRole('checkbox', { name: 'Show all files' }).check();
  await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 2);
  assert.match(await page.locator('.progress-label').innerText(), /^1\/2 · \d+%$/, 'reviewed status survives a browser restart when file identity is unchanged');
  assert.equal(await page.getByRole('checkbox', { name: 'Auto-advance to next unreviewed file' }).isChecked(), true, 'auto-advance keeps its default preference after reload');
  await page.getByRole('checkbox', { name: 'Auto-advance to next unreviewed file' }).check();
  await page.locator('.file-row').nth(1).click();
  await page.getByRole('button', { name: 'Mark unreviewed', exact: true }).click();
  assert.match(await page.locator('.progress-label').innerText(), /^0\/2 · 0%$/);
  await page.locator('.file-row').nth(0).click();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  assert.match(await page.locator('.progress-label').innerText(), /^1\/2 · \d+%$/);
  assert.equal(await page.locator('.path-label strong').innerText(), 'src/b.ts', 'auto-advance selects the next unreviewed file');
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  assert.match(await page.locator('.progress-label').innerText(), /^2\/2 · 100%$/);
  await page.getByRole('button', { name: 'Mark unreviewed', exact: true }).click();
  assert.match(await page.locator('.progress-label').innerText(), /^1\/2 · \d+%$/);
  const draftEdit = page.getByRole('button', { name: 'Edit draft note 31' });
  assert.equal(await draftEdit.count(), 1, 'existing GitLab draft notes can be edited');
  await page.getByRole('button', { name: 'Delete draft note 32' }).click();
  assert.match(await page.getByRole('alert').innerText(), /Draft delete failed/, 'failed GitLab operations are shown to the reviewer');
  await page.waitForFunction(() => !document.querySelector('[aria-label="Delete draft note 32"]')?.disabled);
  const retryResponse = page.waitForResponse(response => response.url().endsWith('/api/gitlab') && response.request().postDataJSON().action === 'delete-draft-note');
  await page.getByRole('button', { name: 'Delete draft note 32' }).click();
  await retryResponse;
  assert.equal(deleteCalls, 2, 'a failed request can be deliberately retried without duplicating its first success');
  await draftEdit.click();
  await page.getByLabel('Edit GitLab draft note').fill('Locally edited pending note');
  await page.locator('.file-row').nth(1).click();
  await page.getByRole('button', { name: '↻ Refresh' }).click();
  await page.reload();
  await page.getByRole('checkbox', { name: 'Show all files' }).check();
  await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 2);
  await page.getByRole('button', { name: 'Edit draft note 31' }).click();
  assert.equal(await page.getByLabel('Edit GitLab draft note').inputValue(), 'Locally edited pending note', 'unsent draft-note edits persist through navigation, refresh and reload');
  await page.getByRole('button', { name: 'Save draft note' }).click();
  await page.getByText('More (1)', { exact: true }).click();
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
  await page.getByRole('checkbox', { name: 'Show all files' }).check();
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
  await page.getByRole('button', { name: 'Close preview', exact: true }).first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByLabel('Find a file').isVisible(), true, 'file search stays available on a narrow screen');
  assert.equal(await page.locator('.file-path').first().isVisible(), true, 'file names remain visible in mobile navigation');
  includeFullFile = true;
  currentMrSha = 'head-full';
  await page.getByRole('button', { name: '↻ Refresh' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 3);
  await page.locator('.file-row').nth(2).click();
  await page.getByRole('button', { name: 'Load full file' }).click();
  await page.waitForFunction(() => !document.querySelector('.diff-warning'));
  await page.waitForFunction(() => document.querySelector('.diff-shell')?.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]'));
  assert.match(await page.locator('diffs-container').evaluate(el => el.shadowRoot?.textContent || ''), /9999/, 'a collapsed 1,500-line file renders its changed lines after loading full contents');
  assert.equal(await page.locator('diff-warning').count(), 0, 'a successfully loaded full file replaces the collapsed-file prompt with its diff');
  assert.equal(await page.getByRole('button', { name: 'Load full file' }).count(), 0, 'loading full file removes the now-unnecessary action');
  await page.evaluate(() => {
    const key = 'review-master:v3:https://gitlab.example:5:2:7';
    const state = JSON.parse(localStorage.getItem(key) || '{}');
    state.reviewed = { 'src/b.ts': 'blob-b' };
    state.autoAdvance = true;
    localStorage.setItem(key, JSON.stringify(state));
  });
  holdIdentityHydration = true;
  const identityRequested = new Promise(resolve => { identityRequestSignal = resolve; });
  await page.reload();
  await identityRequested;
  await page.waitForFunction(() => document.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]'));
  assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).isDisabled(), true, 'a file cannot be marked reviewed until its content identity is known');
  await page.getByRole('checkbox', { name: 'Auto-advance to next unreviewed file' }).uncheck();
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('review-master:v3:https://gitlab.example:5:2:7')).reviewed), { 'src/b.ts': 'blob-b' }, 'saving another review preference keeps unresolved reviewed candidates in local storage');
  releaseIdentityHydration();
  holdIdentityHydration = false;
  await page.getByRole('checkbox', { name: 'Show all files' }).check();
  await page.locator('.file-row').nth(1).click();
  await page.getByRole('button', { name: 'Mark unreviewed', exact: true }).waitFor();
  assert.match(await page.locator('.progress-label').innerText(), /^1\/3 · /, 'matching identities restore the previously reviewed file after hydration');
  assert.deepEqual(errors, [], 'browser console should have no page exceptions');
  await context.close();
});
