import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = new URL('../', import.meta.url).pathname;
const mrUrl = 'https://gitlab.example/group/app/-/merge_requests/7';
const mr = { id: 77, iid: 7, project_id: 2, title: 'Review a focused change', description: '', state: 'opened', web_url: mrUrl, source_branch: 'feature', target_branch: 'main', sha: 'head-two', diff_refs: { base_sha: 'base-two', head_sha: 'head-two', start_sha: 'base-two' }, author: { username: 'reviewer', name: 'Reviewer' } };
const reviewFiles = [
  { old_path: 'src/a.ts', new_path: 'src/a.ts', diff: '@@ -1 +1 @@\n-oldA\n+newA\n', new_file: false, deleted_file: false, renamed_file: false, identity: 'blob-a' },
  { old_path: 'src/b.ts', new_path: 'src/b.ts', diff: '@@ -1 +1 @@\n-oldB\n+newB\n', new_file: false, deleted_file: false, renamed_file: false, identity: 'blob-b' },
];
const push = (id, sha) => ({ id, created_at: `2026-10-${String(id + 13).padStart(2, '0')}T12:00:00Z`, head_commit_sha: sha, base_commit_sha: `base-${sha}`, start_commit_sha: `base-${sha}`, state: 'collected' });
const zenCommit = { id: 'c0ffee1234567890c0ffee1234567890c0ffee12', short_id: 'c0ffee12', title: 'Correct the commit-specific behavior', author_name: 'Reviewer', committed_date: '2026-10-15T12:00:00Z' };
const commitFiles = [{ old_path: 'src/commit.ts', new_path: 'src/commit.ts', diff: '@@ -1 +1 @@\n-const value = "old";\n+const value = "commit inspection";\n', new_file: false, deleted_file: false, renamed_file: false, identity: null }];
let largeDiffMode = false;
let standardDiffMode = false;
const largeDiff = '@@ -0,0 +1,2200 @@\n' + Array.from({ length: 2200 }, (_, index) => `+export const line${index + 1} = ${index + 1};`).join('\n') + '\n';
const standardLongDiff = '@@ -0,0 +1,240 @@\n' + Array.from({ length: 240 }, (_, index) => `+export const line${index + 1} = ${index + 1};`).join('\n') + '\n';

async function availablePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('Zen panels preserve review context, inspect real commits, and work with keyboard and touch', { timeout: 120_000 }, async t => {
  let versions = [push(2, 'head-two'), push(1, 'head-one')];
  const calls = [];
  const submittedComments = [];
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
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (!await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5_000))])) {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await exited;
    }
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(baseUrl)).ok) { ready = true; break; } } catch { /* wait for Nuxt */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(ready, true, `Nuxt dev server should start. ${serverLogs.slice(-8).join('')}`);
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  let emptyReview = false;
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/api/gitlab', async route => {
    const request = route.request().postDataJSON();
    calls.push(request.action);
    const versionIndex = versionId => versions.findIndex(version => version.id === versionId);
    const versionData = versionId => {
      const index = versionIndex(versionId);
      const version = versions[index];
      const previous = versions[index + 1];
      return {
        mr: { ...mr, sha: version.head_commit_sha, diff_refs: { base_sha: previous?.head_commit_sha || version.base_commit_sha, head_sha: version.head_commit_sha, start_sha: previous?.head_commit_sha || version.start_commit_sha } },
        user: { id: 5, username: 'reviewer', name: 'Reviewer' }, project: { id: 2 },
        diffs: emptyReview ? [] : reviewFiles.map(file => ({ ...file, diff: file.new_path === 'src/a.ts' ? largeDiffMode ? largeDiff : standardDiffMode ? standardLongDiff : file.diff : file.diff })), versions,
        selectedVersionId: version.id, versionIsInitial: !previous, versionIsLatest: index === 0,
        commentRefs: { base_sha: version.base_commit_sha, head_sha: version.head_commit_sha, start_sha: version.start_commit_sha },
        commentableLines: [{ old_path: 'src/a.ts', new_path: 'src/a.ts', old_lines: [], new_lines: [1, 240] }],
        discussions: [], draftNotes: [], codeowners: [{ pattern: 'src/a.ts', owners: ['reviewer'] }], ownerStatus: { reviewer: true },
      };
    };
    const result = request.action === 'bootstrap' ? versionData(versions[0].id)
      : request.action === 'version-diff' ? versionData(Number(request.payload.versionId))
      : request.action === 'file-identities' ? { identities: Object.fromEntries(request.payload.paths.map(path => [path, path === 'src/a.ts' ? 'blob-a' : 'blob-b'])) }
      : request.action === 'verify-owners' ? { codeowners: [{ pattern: 'src/a.ts', owners: ['reviewer'] }], ownerStatus: { reviewer: true } }
      : request.action === 'refresh' ? { mr: { ...mr, sha: versions[0].head_commit_sha }, versions, discussions: [], draftNotes: [] }
      : request.action === 'mr-commits' ? [zenCommit]
      : request.action === 'commit-diff' ? { commitId: request.payload.sha, diffs: commitFiles.map(file => ({ ...file })) }
      : request.action === 'preview' ? { previews: [{ url: 'https://preview.example/app', environment: 'qa', match: 'exact', stale: false }] }
      : request.action === 'open-preview' ? { url: request.payload.url }
      : request.action === 'comment' ? (submittedComments.push(request.payload), { id: 99 })
      : {};
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await context.route('https://preview.example/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Review preview</title>' }));
  standardDiffMode = true;
  await page.goto(`${baseUrl}/?mr=${encodeURIComponent(mrUrl)}`);
  try {
    await page.locator('.file-row').first().waitFor({ timeout: 20_000 });
    await page.locator('diffs-container').waitFor();
  } catch {
    throw new Error(`MR review did not load. ${serverLogs.slice(-10).join('')}`);
  }

  await page.waitForFunction(() => document.querySelector('diffs-container')?.shadowRoot?.textContent?.includes('line240'));
  const regularDiffScroll = page.locator('diffs-container');
  const regularDiffProbe = await regularDiffScroll.evaluate(diff => {
    const bounds = diff.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, clientHeight: diff.clientHeight, scrollHeight: diff.scrollHeight };
  });
  assert.ok(regularDiffProbe.scrollHeight > regularDiffProbe.clientHeight, `the regular single-file diff owns its overflow: ${JSON.stringify(regularDiffProbe)}`);
  await page.mouse.move(regularDiffProbe.x, regularDiffProbe.y);
  await page.mouse.wheel(0, 600);
  await page.waitForFunction(() => document.querySelector('diffs-container')?.scrollTop > 0);
  const regularDiffState = await page.evaluate(() => ({
    diffTop: document.querySelector('diffs-container').scrollTop,
    wrapperTop: document.querySelector('.diff-scroll').scrollTop,
    pageTop: document.scrollingElement.scrollTop,
  }));
  assert.ok(regularDiffState.diffTop > 0, `wheel input scrolls PierreDiff in regular mode: ${JSON.stringify(regularDiffState)}`);
  assert.equal(regularDiffState.wrapperTop, 0, `the regular diff wrapper stays in place: ${JSON.stringify(regularDiffState)}`);
  assert.equal(regularDiffState.pageTop, 0, `the regular page stays in place: ${JSON.stringify(regularDiffState)}`);
  await regularDiffScroll.evaluate(diff => { diff.scrollTop = diff.scrollHeight; });
  await page.waitForFunction(() => {
    const diff = document.querySelector('diffs-container');
    return diff && diff.scrollTop + diff.clientHeight >= diff.scrollHeight - 1;
  });
  const regularHeaderState = await regularDiffScroll.evaluate(diff => {
    const header = diff.shadowRoot?.querySelector('[data-diffs-header]');
    return { top: header?.getBoundingClientRect().top, containerTop: diff.getBoundingClientRect().top, text: header?.textContent?.trim() || '' };
  });
  assert.ok(Math.abs((regularHeaderState.top ?? Infinity) - regularHeaderState.containerTop) <= 1, `PierreDiff keeps its header visible in regular mode: ${JSON.stringify(regularHeaderState)}`);
  assert.match(regularHeaderState.text, /src\/a\.ts/);
  if (process.env.RMR9_SCREENSHOT_DIR) {
    await mkdir(process.env.RMR9_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.RMR9_SCREENSHOT_DIR, 'desktop-single-file-diff-scroll.png') });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await regularDiffScroll.evaluate(diff => { diff.scrollTop = 0; });
  await page.mouse.move(195, 420);
  await page.mouse.wheel(0, 420);
  await page.waitForFunction(() => document.querySelector('diffs-container')?.scrollTop > 0);
  const mobileRegularDiffState = await page.evaluate(() => ({
    diffTop: document.querySelector('diffs-container').scrollTop,
    wrapperTop: document.querySelector('.diff-scroll').scrollTop,
    pageTop: document.scrollingElement.scrollTop,
  }));
  assert.ok(mobileRegularDiffState.diffTop > 0, `mobile wheel input scrolls PierreDiff: ${JSON.stringify(mobileRegularDiffState)}`);
  assert.equal(mobileRegularDiffState.wrapperTop, 0, `the mobile diff wrapper stays in place: ${JSON.stringify(mobileRegularDiffState)}`);
  assert.equal(mobileRegularDiffState.pageTop, 0, `the mobile page stays in place: ${JSON.stringify(mobileRegularDiffState)}`);
  await regularDiffScroll.evaluate(diff => { diff.scrollTop = diff.scrollHeight; });
  await page.waitForFunction(() => {
    const diff = document.querySelector('diffs-container');
    return diff && diff.scrollTop + diff.clientHeight >= diff.scrollHeight - 1;
  });
  if (process.env.RMR9_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.RMR9_SCREENSHOT_DIR, 'mobile-single-file-diff-scroll.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await regularDiffScroll.evaluate(diff => { diff.scrollTop = 0; });
  await page.locator('.display-menu summary').click();
  await page.getByRole('checkbox', { name: 'Continuous files' }).check();
  await page.waitForFunction(() => {
    const scroller = document.querySelector('.diff-scroll');
    return scroller?.classList.contains('continuous-scroll') && scroller.scrollHeight > scroller.clientHeight;
  });
  const continuousScrollProbe = await page.locator('.diff-scroll').evaluate(scroller => {
    const bounds = scroller.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  });
  await page.mouse.move(continuousScrollProbe.x, continuousScrollProbe.y);
  await page.mouse.wheel(0, 420);
  await page.waitForFunction(() => document.querySelector('.diff-scroll')?.scrollTop > 0);
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0, 'continuous files keeps scrolling in its list');
  standardDiffMode = false;
  await page.reload();
  await page.locator('.file-row').first().waitFor();
  await page.locator('diffs-container').waitFor();

  await page.getByRole('checkbox', { name: 'Auto-advance to next unreviewed file' }).uncheck();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  const progressBefore = await page.locator('.topbar .progress-label').innerText();
  await page.evaluate(() => { window.__zenDiff = document.querySelector('diffs-container'); });
  const pathBefore = await page.locator('.path-label strong').innerText();
  await page.locator('#review-comment').fill('Revision draft stays with its file');
  await page.locator('diffs-container').locator('[data-line]').last().click();
  await page.getByText('Comment on selected diff line', { exact: false }).waitFor();
  const revisionHistoryTab = page.getByRole('tab', { name: /History/ });
  await revisionHistoryTab.click();
  const selectedRevision = await page.locator('.history-row.selected .history-sha').innerText();
  await page.getByRole('tab', { name: /Files/ }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.locator('iframe[title="Merge request preview"]').waitFor();
  await page.getByRole('button', { name: 'Unified', exact: true }).click();

  const callsBeforeZen = [...calls];
  await page.getByRole('button', { name: 'Enter Zen Mode' }).click();
  await page.locator('.review-layout.zen-mode').waitFor();
  await page.waitForTimeout(320);
  assert.equal(await page.locator('diffs-container').evaluate(element => element === window.__zenDiff), true, 'entering Zen does not remount the existing diff renderer');
  assert.deepEqual(calls, callsBeforeZen, 'entering Zen performs no API request or duplicate review polling');
  assert.equal(await page.locator('.preview-pane iframe').getAttribute('src'), 'https://preview.example/app', 'an open preview survives the mode transition');
  await page.getByRole('button', { name: 'Close preview' }).click();
  await page.locator('.preview-pane').waitFor({ state: 'detached' });
  const fullWidth = await page.locator('.review-main').evaluate(element => ({ left: element.getBoundingClientRect().left, width: element.getBoundingClientRect().width, viewport: window.innerWidth }));
  assert.ok(fullWidth.left <= 1 && fullWidth.width >= fullWidth.viewport - 1, 'the central review expands across the available viewport');
  assert.equal(await page.locator('.file-sidebar').evaluate(element => getComputedStyle(element).visibility), 'hidden', 'the Files panel is fully hidden while idle');
  assert.equal(await page.locator('#zen-history-panel').evaluate(element => getComputedStyle(element).visibility), 'hidden', 'History is fully hidden while idle');
  assert.equal(await page.locator('.comment-panel').evaluate(element => getComputedStyle(element).visibility), 'hidden', 'Activity and comments are fully hidden while idle');
  assert.equal(await page.locator('.zen-edge').count(), 4, 'four accessible edge handles remain available');
  const zenFileReviewToggle = page.locator('.review-main > .file-toolbar .review-toggle');
  assert.equal(await zenFileReviewToggle.isVisible(), true, 'the active file review action stays visible in the Zen header');
  assert.equal(await zenFileReviewToggle.innerText(), 'Mark unreviewed', 'the Zen header reflects the active file review state');
  const zenProgressBeforeToggle = await page.locator('.topbar .progress-label').innerText();
  await zenFileReviewToggle.click();
  assert.equal(await zenFileReviewToggle.innerText(), 'Mark reviewed', 'the file can be marked unreviewed directly from the Zen header');
  assert.notEqual(await page.locator('.topbar .progress-label').innerText(), zenProgressBeforeToggle, 'the Zen header action updates review progress');
  await zenFileReviewToggle.click();
  assert.equal(await zenFileReviewToggle.innerText(), 'Mark unreviewed', 'the file can be marked reviewed directly from the Zen header');
  assert.equal(await page.locator('.topbar .progress-label').innerText(), zenProgressBeforeToggle, 'the Zen header can restore the file review state');
  assert.equal(await page.locator('.topbar .progress-label').innerText(), progressBefore, 'review progress stays unchanged');
  assert.equal(await page.locator('.path-label strong').innerText(), pathBefore, 'the selected file stays unchanged');
  standardDiffMode = true;
  const standardHistoryHandle = page.locator('#zen-edge-history');
  const standardHistoryBox = await standardHistoryHandle.boundingBox();
  await page.mouse.move(standardHistoryBox.x + standardHistoryBox.width / 2, standardHistoryBox.y + standardHistoryBox.height / 2);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#zen-history-panel')).visibility === 'visible');
  const earlierRevision = page.locator('.zen-revision-row').nth(1);
  const earlierRevisionSha = await earlierRevision.locator('.history-sha').innerText();
  await earlierRevision.click();
  await page.waitForFunction(sha => document.querySelector('.zen-revision-row.selected .history-sha')?.textContent === sha, earlierRevisionSha);
  await page.waitForFunction(() => {
    const diff = document.querySelector('diffs-container');
    return diff && diff.scrollHeight > diff.clientHeight;
  });
  const standardScrollProbe = await page.locator('diffs-container').evaluate(container => {
    const bounds = container.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, height: container.clientHeight, scrollHeight: container.scrollHeight };
  });
  assert.ok(standardScrollProbe.scrollHeight > standardScrollProbe.height, `the standard diff container has vertical overflow: ${JSON.stringify(standardScrollProbe)}`);
  await page.mouse.move(standardScrollProbe.x, standardScrollProbe.y);
  await page.mouse.wheel(0, 600);
  await page.waitForFunction(() => document.querySelector('diffs-container')?.scrollTop > 0);
  const standardScrollState = await page.evaluate(() => ({
    diffTop: document.querySelector('diffs-container').scrollTop,
    wrapperTop: document.querySelector('.diff-scroll').scrollTop,
    pageTop: document.scrollingElement.scrollTop,
  }));
  assert.ok(standardScrollState.diffTop > 0, `wheel input scrolls the diffs-container: ${JSON.stringify(standardScrollState)}`);
  assert.equal(standardScrollState.wrapperTop, 0, `the outer diff wrapper stays in place: ${JSON.stringify(standardScrollState)}`);
  assert.equal(standardScrollState.pageTop, 0, `the document stays in place: ${JSON.stringify(standardScrollState)}`);
  const stickyHeaderState = await page.locator('diffs-container').evaluate(container => {
    const header = container.shadowRoot?.querySelector('[data-diffs-header]');
    return {
      position: header ? getComputedStyle(header).position : null,
      top: header?.getBoundingClientRect().top,
      containerTop: container.getBoundingClientRect().top,
      text: header?.textContent?.trim() || '',
    };
  });
  assert.equal(stickyHeaderState.position, 'sticky', `the file header uses sticky positioning: ${JSON.stringify(stickyHeaderState)}`);
  assert.ok(Math.abs((stickyHeaderState.top ?? Infinity) - stickyHeaderState.containerTop) <= 1, `the file header remains at the top of its scrolling diff: ${JSON.stringify(stickyHeaderState)}`);
  assert.match(stickyHeaderState.text, /src\/a\.ts/, 'the file path remains visible while scrolling');
  if (process.env.RMR9_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.RMR9_SCREENSHOT_DIR, 'desktop-zen-diffs-container-scroll.png') });
  await page.setViewportSize({ width: 650, height: 892 });
  await page.locator('diffs-container').evaluate(container => container.scrollTo({ top: container.scrollHeight }));
  await page.waitForFunction(() => {
    const diff = document.querySelector('diffs-container');
    return diff && diff.scrollTop > 0 && diff.scrollTop + diff.clientHeight >= diff.scrollHeight - 1;
  });
  const compactDiffSafeArea = await page.evaluate(() => {
    const diff = document.querySelector('diffs-container').getBoundingClientRect();
    const controls = document.querySelector('#zen-edge-controls').getBoundingClientRect();
    const activity = document.querySelector('#zen-edge-activity').getBoundingClientRect();
    return { diffTop: diff.top, diffBottom: diff.bottom, controlsBottom: controls.bottom, activityTop: activity.top };
  });
  assert.ok(compactDiffSafeArea.diffTop >= compactDiffSafeArea.controlsBottom, `the scrolled diff stays below the top handle: ${JSON.stringify(compactDiffSafeArea)}`);
  assert.ok(compactDiffSafeArea.diffBottom <= compactDiffSafeArea.activityTop, `the scrolled diff stays above the bottom handle: ${JSON.stringify(compactDiffSafeArea)}`);
  if (process.env.RMR9_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.RMR9_SCREENSHOT_DIR, 'desktop-zen-diffs-container-compact-bottom.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('diffs-container').evaluate(container => container.scrollTo({ top: 0 }));
  await page.mouse.move(standardHistoryBox.x + standardHistoryBox.width / 2, standardHistoryBox.y + standardHistoryBox.height / 2);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#zen-history-panel')).visibility === 'visible');
  await page.locator('.zen-revision-row').first().click();
  await page.waitForFunction(sha => document.querySelector('.zen-revision-row.selected .history-sha')?.textContent === sha, selectedRevision);
  standardDiffMode = false;

  largeDiffMode = true;
  const historyForLargeDiff = page.locator('#zen-edge-history');
  await historyForLargeDiff.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#zen-history-panel')).visibility === 'visible');
  await page.getByRole('tab', { name: 'Revisions' }).click();
  await page.locator('.zen-revision-row').nth(1).click();
  await page.locator('.diff-shell.code-view').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const view = window.__INSTANCE;
    return view?.workerManager?.getStats().managerState === 'initialized' && view.renderState.firstIndex >= 0;
  }, null, { timeout: 30_000 });
  const scrollProbe = await page.locator('.diff-shell.code-view').evaluate(editor => {
    const bounds = editor.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  });
  await page.mouse.move(scrollProbe.x, scrollProbe.y);
  await page.mouse.wheel(0, 600);
  await page.waitForFunction(() => document.querySelector('.diff-shell.code-view')?.scrollTop > 0);
  const scrollState = await page.evaluate(() => {
    const editor = document.querySelector('.diff-shell.code-view');
    return {
      editorTop: editor.scrollTop,
      editorHeight: editor.clientHeight,
      editorScrollHeight: editor.scrollHeight,
      diffScrollTop: document.querySelector('.diff-scroll').scrollTop,
      layoutTop: document.querySelector('.review-layout').scrollTop,
      workspaceTop: document.querySelector('.workspace').scrollTop,
      pageTop: document.scrollingElement.scrollTop,
    };
  });
  assert.ok(scrollState.editorScrollHeight > scrollState.editorHeight, `the actual CodeView editor has overflow: ${JSON.stringify(scrollState)}`);
  assert.ok(scrollState.editorTop > 0, `wheel input scrolls the actual diff editor: ${JSON.stringify(scrollState)}`);
  assert.equal(scrollState.diffScrollTop, 0, `the diff wrapper stays in place: ${JSON.stringify(scrollState)}`);
  assert.equal(scrollState.layoutTop, 0, `the review layout stays in place: ${JSON.stringify(scrollState)}`);
  assert.equal(scrollState.workspaceTop, 0, `the Zen workspace stays in place: ${JSON.stringify(scrollState)}`);
  assert.equal(scrollState.pageTop, 0, `the document stays in place: ${JSON.stringify(scrollState)}`);
  if (process.env.RMR9_SCREENSHOT_DIR) {
    await mkdir(process.env.RMR9_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.RMR9_SCREENSHOT_DIR, 'desktop-zen-codeview-scroll.png') });
  }
  largeDiffMode = false;
  await historyForLargeDiff.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#zen-history-panel')).visibility === 'visible');
  await page.getByRole('tab', { name: 'Revisions' }).click();
  await page.locator('.zen-revision-row').first().click();
  await page.locator('diffs-container').waitFor();
  await page.mouse.move(720, 430);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#zen-history-panel')).visibility === 'hidden');

  const screenshotDir = process.env.RMR9_SCREENSHOT_DIR;
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: join(screenshotDir, 'desktop-zen-idle.png') });
  }

  await page.setViewportSize({ width: 650, height: 892 });
  const compactSafeArea = await page.evaluate(() => {
    const diff = document.querySelector('.diff-scroll').getBoundingClientRect();
    const controls = document.querySelector('#zen-edge-controls').getBoundingClientRect();
    const activity = document.querySelector('#zen-edge-activity').getBoundingClientRect();
    return { diffTop: diff.top, diffBottom: diff.bottom, controlsBottom: controls.bottom, activityTop: activity.top };
  });
  assert.ok(compactSafeArea.diffTop >= compactSafeArea.controlsBottom, `the top edge handle does not cover the diff: ${JSON.stringify(compactSafeArea)}`);
  assert.ok(compactSafeArea.diffBottom <= compactSafeArea.activityTop, `the bottom edge handle does not cover the diff: ${JSON.stringify(compactSafeArea)}`);
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'desktop-zen-compact-safe-area.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  const filesHandle = page.locator('#zen-edge-files');
  const filesHandleBox = await filesHandle.boundingBox();
  await page.mouse.move(filesHandleBox.x + filesHandleBox.width / 2, filesHandleBox.y + filesHandleBox.height / 2);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.file-sidebar')).visibility === 'visible');
  await page.waitForTimeout(260);
  await page.getByRole('checkbox', { name: 'Show all files' }).check();
  const filesPanelBox = await page.locator('.file-sidebar').boundingBox();
  await page.mouse.move(filesPanelBox.x + filesPanelBox.width - 24, filesPanelBox.y + 120);
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.file-sidebar').evaluate(element => getComputedStyle(element).visibility), 'visible', 'crossing from a handle into its overlay keeps the panel open');
  await page.locator('.file-row').nth(1).click();
  assert.equal(await page.locator('.path-label strong').innerText(), 'src/b.ts', 'the Files panel updates the shared central review');
  await page.locator('.file-row').first().click();
  assert.equal(await page.locator('.path-label strong').innerText(), pathBefore, 'the Files panel can return to the original review file');
  await page.getByRole('checkbox', { name: 'Show all files' }).uncheck();
  await page.locator('diffs-container').locator('[data-line]').last().click();
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(720, 430);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.file-sidebar')).visibility === 'hidden');

  const controlsHandle = page.locator('#zen-edge-controls');
  await controlsHandle.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#zen-controls-panel')).visibility === 'visible');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close Controls panel', 'keyboard opening moves focus into the panel');
  assert.equal(await page.locator('#zen-controls-panel [aria-label="Diff layout"] button').nth(1).getAttribute('aria-pressed'), 'true', 'layout choice is retained in the floating controls');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#zen-controls-panel')).visibility === 'hidden');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'zen-edge-controls', 'Escape returns focus to the handle');
  const historyHandle = page.locator('#zen-edge-history');
  const historyHandleBox = await historyHandle.boundingBox();
  await page.mouse.move(historyHandleBox.x + historyHandleBox.width / 2, historyHandleBox.y + historyHandleBox.height / 2);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#zen-history-panel')).visibility === 'visible');
  assert.ok(await page.locator('.zen-revision-row.selected').count(), 'Revisions indicates the selected push version');
  await page.waitForTimeout(300);
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'desktop-zen-revisions.png') });
  const versionDiffCallsBeforeCommitInspection = calls.filter(action => action === 'version-diff').length;
  await page.getByRole('tab', { name: 'Commits' }).click();
  await page.locator('.zen-commit-row').first().waitFor();
  await page.waitForTimeout(300);
  assert.ok(calls.includes('mr-commits'), 'Commits loads GitLab MR commit data');
  await page.locator('.zen-commit-row').first().click();
  await page.locator('.zen-history-heading').getByText('Inspecting commit', { exact: false }).waitFor();
  await page.locator('diffs-container').waitFor();
  assert.equal(await page.locator('.path-label strong').innerText(), 'src/commit.ts', 'selecting a commit loads its own GitLab diff');
  assert.ok((await page.locator('.commit-inspection-banner').innerText()).includes('Push version'), 'the UI distinguishes commit inspection from push-version selection');
  assert.equal(await page.locator('.file-heading .review-toggle').isDisabled(), true, 'commit inspection cannot mark a revision file reviewed');
  assert.equal(calls.filter(action => action === 'version-diff').length, versionDiffCallsBeforeCommitInspection, 'commit inspection does not navigate or fetch a push revision');

  const activityHandle = page.locator('#zen-edge-activity');
  const activityBox = await activityHandle.boundingBox();
  await page.mouse.move(activityBox.x + activityBox.width / 2, activityBox.y + activityBox.height / 2);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.comment-panel')).visibility === 'visible');
  await page.locator('diffs-container').locator('[data-line]').last().click();
  assert.match(await page.locator('.comment-form > label').innerText(), /MR-level comment/, 'commit line selection is never labeled as a safe inline position');
  await page.locator('#review-comment').fill('A commit inspection comment');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#review-comment')?.value === '');
  assert.equal(submittedComments.at(-1).position, undefined, 'commit inspection posts no guessed diff coordinates');

  const restoreBeforePushHandle = page.locator('#zen-edge-history');
  const restoreBeforePushBox = await restoreBeforePushHandle.boundingBox();
  await page.mouse.move(restoreBeforePushBox.x + restoreBeforePushBox.width / 2, restoreBeforePushBox.y + restoreBeforePushBox.height / 2);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#zen-history-panel')).visibility === 'visible');
  await page.getByRole('tab', { name: 'Revisions' }).click();
  const activityBeforePushHandle = page.locator('#zen-edge-activity');
  const activityBeforePushBox = await activityBeforePushHandle.boundingBox();
  await page.mouse.move(activityBeforePushBox.x + activityBeforePushBox.width / 2, activityBeforePushBox.y + activityBeforePushBox.height / 2);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.comment-panel')).visibility === 'visible');
  assert.equal(await page.locator('.path-label strong').innerText(), pathBefore, 'returning to Revisions preserves the selected review file');
  assert.equal(await page.locator('#review-comment').inputValue(), 'Revision draft stays with its file', 'returning to Revisions restores its file-specific draft');
  assert.match(await page.locator('.comment-form > label').innerText(), /Comment on selected diff line/, 'returning to Revisions preserves its verified line selection');
  const commitsAgainHandle = page.locator('#zen-edge-history');
  const commitsAgainBox = await commitsAgainHandle.boundingBox();
  await page.mouse.move(commitsAgainBox.x + commitsAgainBox.width / 2, commitsAgainBox.y + commitsAgainBox.height / 2);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#zen-history-panel')).visibility === 'visible');
  await page.getByRole('tab', { name: 'Commits' }).click();
  await page.locator('.zen-commit-row').first().click();
  await page.locator('.commit-inspection-banner').waitFor();

  versions = [push(3, 'head-three'), ...versions];
  const beforeRefresh = calls.filter(action => action === 'refresh').length;
  await page.locator('#zen-edge-controls').focus();
  await page.keyboard.press('Enter');
  const refreshButton = page.getByRole('button', { name: 'Refresh merge request' });
  await refreshButton.click();
  for (let attempt = 0; attempt < 100 && calls.filter(action => action === 'refresh').length === beforeRefresh; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.filter(action => action === 'refresh').length, beforeRefresh + 1, 'Zen refresh uses the existing review poll once');
  assert.equal(await page.locator('.path-label strong').innerText(), 'src/commit.ts', 'a new push does not interrupt commit inspection');
  assert.match(await page.locator('.commit-inspection-banner').innerText(), /Push version 2 remains selected/, 'the prior push selection remains explicit during commit inspection');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Refresh merge request', 'new-push notification does not steal focus');

  const currentHistoryHandle = page.locator('#zen-edge-history');
  const currentHistoryBox = await currentHistoryHandle.boundingBox();
  await page.mouse.move(currentHistoryBox.x + currentHistoryBox.width / 2, currentHistoryBox.y + currentHistoryBox.height / 2);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#zen-history-panel')).visibility === 'visible');
  await page.getByRole('tab', { name: 'Revisions' }).click();
  assert.equal(await page.locator('.zen-revision-row').count(), 3, 'the refreshed revision list includes a new push');
  assert.equal(await page.locator('.commit-inspection-banner').count(), 0, 'Revisions returns to the existing review without changing its selection');
  assert.equal(await page.locator('.zen-revision-row[aria-current="page"] .history-sha').innerText(), selectedRevision, 'the selected push version is restored after commit inspection');
  assert.match(await page.locator('.zen-revision-row').first().innerText(), /New/, 'new push is visible without selecting it');
  assert.equal(await page.locator('.path-label strong').innerText(), pathBefore, 'the previously selected revision file is restored');
  assert.equal(await page.locator('.topbar .progress-label').innerText(), progressBefore, 'per-version progress is restored');
  const restoreActivityHandle = page.locator('#zen-edge-activity');
  const restoreActivityBox = await restoreActivityHandle.boundingBox();
  await page.mouse.move(restoreActivityBox.x + restoreActivityBox.width / 2, restoreActivityBox.y + restoreActivityBox.height / 2);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.comment-panel')).visibility === 'visible');
  assert.equal(await page.locator('#review-comment').inputValue(), 'Revision draft stays with its file', 'the revision comment draft is restored');
  assert.match(await page.locator('.comment-form > label').innerText(), /Add an MR-level comment/, 'a new push invalidates the old line anchor and leaves a safe MR-level comment');

  await page.evaluate(() => { window.__zenDiff = document.querySelector('diffs-container'); });
  await page.locator('#zen-edge-controls').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Exit Zen Mode' }).click();
  await page.locator('.review-layout:not(.zen-mode)').waitFor();
  assert.equal(await page.locator('diffs-container').evaluate(element => element === window.__zenDiff), true, 'exiting Zen does not remount the current diff');
  assert.equal(await page.locator('.path-label strong').innerText(), pathBefore, 'normal mode resumes with the same selected file');
  assert.deepEqual(errors, [], 'the browser reports no page exceptions');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByRole('button', { name: 'Enter Zen Mode' }).isVisible(), true, 'Zen mode remains available in the mobile header');
  assert.equal(await page.getByRole('button', { name: '↻ Refresh' }).isVisible(), true, 'the existing mobile refresh action remains visible');
  await page.getByRole('button', { name: 'Enter Zen Mode' }).click();
  await page.locator('.review-layout.zen-mode').waitFor();
  const mobileZenReviewToggle = page.locator('.review-main > .file-toolbar .review-toggle');
  assert.equal(await mobileZenReviewToggle.isVisible(), true, 'the file review action stays available in the mobile Zen header');
  assert.equal(await mobileZenReviewToggle.innerText(), 'Mark unreviewed', 'the mobile Zen header reflects the active file review state');
  await mobileZenReviewToggle.click();
  assert.equal(await mobileZenReviewToggle.innerText(), 'Mark reviewed', 'the file can be marked unreviewed from the mobile Zen header');
  await mobileZenReviewToggle.click();
  assert.equal(await mobileZenReviewToggle.innerText(), 'Mark unreviewed', 'the mobile Zen header can restore the file review state');
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'mobile-zen-idle-review-toggle.png') });
  const touchHistory = page.locator('#zen-edge-history');
  const touchHistoryBox = await touchHistory.boundingBox();
  assert.ok(touchHistoryBox.width >= 44 && touchHistoryBox.height >= 44, 'the tiny visible nudge has a touch-sized hit target');
  await page.touchscreen.tap(touchHistoryBox.x + touchHistoryBox.width / 2, touchHistoryBox.y + touchHistoryBox.height / 2);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#zen-history-panel')).visibility === 'visible');
  await page.getByRole('tab', { name: 'Commits' }).click();
  await page.locator('.zen-commit-row').first().waitFor();
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'mobile-zen-commits.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const activityTouch = page.locator('#zen-edge-activity');
  const activityTouchBox = await activityTouch.boundingBox();
  await page.touchscreen.tap(activityTouchBox.x + activityTouchBox.width / 2, activityTouchBox.y + activityTouchBox.height / 2);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.comment-panel')).visibility === 'visible');
  const reducedTransition = await page.locator('.comment-panel').evaluate(element => getComputedStyle(element).transitionDuration.split(',').map(value => value.trim()));
  assert.ok(reducedTransition.every(value => value === '0s' || value === '0ms'), 'reduced motion removes the panel transition');
  assert.equal(await page.getByLabel('Add an MR-level comment').isVisible(), true, 'touch can open the real activity composer without hover');

  emptyReview = true;
  await page.goto(`${baseUrl}/?mr=${encodeURIComponent(mrUrl)}`);
  const zenButton = page.getByRole('button', { name: 'Enter Zen Mode' });
  await zenButton.waitFor();
  await zenButton.click();
  await page.locator('.review-layout.zen-mode').waitFor();
  assert.deepEqual(errors, [], 'Zen controls render safely when the MR has no changed files');
});
