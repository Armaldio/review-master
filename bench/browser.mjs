import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright-core';

const root = new URL('../', import.meta.url).pathname;
const scenarios = [
  { name: 'many-small-files', files: 40, linesPerFile: 120 },
  { name: 'two-large-single-hunk-files', files: 2, linesPerFile: 20_000 },
];
const errors = [];
const portServer = createServer();
await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));

const child = spawn(process.execPath, ['.output/server/index.mjs'], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port) },
});
child.stderr.on('data', value => errors.push(value.toString()));

let browser;
try {
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(baseUrl)).ok) { ready = true; break; } } catch { /* wait for Nitro */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Production server did not start: ${errors.join('')}`);

  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const results = [];
  const thresholdFailures = [];
  for (const scenario of scenarios) {
    const paths = Array.from({ length: scenario.files }, (_, index) => `src/file-${String(index + 1).padStart(3, '0')}.ts`);
    const patch = path => `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${scenario.linesPerFile} @@\n${Array.from({ length: scenario.linesPerFile }, (_, index) => `+export const item${index} = ${index};`).join('\n')}\n`;
    const mr = { id: 77, iid: 7, title: scenario.name, description: '', state: 'opened', web_url: 'https://gitlab.example/group/app/-/merge_requests/7', source_branch: 'bench', target_branch: 'main', sha: 'head', diff_refs: { base_sha: 'base', head_sha: 'head', start_sha: 'start' }, source_project_id: 2, target_project_id: 2, author: { username: 'bench', name: 'Benchmark' } };
    const data = { mr, user: { id: 5, username: 'bench', name: 'Benchmark' }, project: { id: 2, path: 'group/app' }, discussions: [], draftNotes: [], codeowners: [], diffs: paths.map(path => ({ old_path: path, new_path: path, old_id: 'old-blob', new_id: 'new-blob', diff: patch(path), new_file: true, deleted_file: false, renamed_file: false, identity: path })) };
    const context = await browser.newContext();
    const page = await context.newPage();
    const commentPayloads = [];
    page.on('pageerror', error => errors.push(`${scenario.name}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${scenario.name}: ${message.text()}`); });
    await context.route('**/api/gitlab', route => {
      const request = route.request().postDataJSON();
      if (request.action === 'comment') commentPayloads.push(request.payload);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(request.action === 'bootstrap' ? data : { mr, discussions: [], draftNotes: [] }) });
    });

    await page.goto(baseUrl);
    await page.getByRole('textbox', { name: 'Merge request URL' }).waitFor();
    const started = performance.now();
    await page.getByRole('textbox', { name: 'Merge request URL' }).fill(mr.web_url);
    await page.getByRole('button', { name: 'Open review' }).click();
    await page.waitForFunction(path => {
      const root = document.querySelector(`.diff-shell[data-path="${path}"] diffs-container`);
      return root?.shadowRoot?.querySelector('[data-line]') != null;
    }, paths[0], { timeout: 30_000 });
    const firstVisibleLineMs = performance.now() - started;
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const beforeHeap = await cdp.send('Runtime.getHeapUsage');
    const beforeDom = await cdp.send('Memory.getDOMCounters');
    const beforeMetrics = await cdp.send('Performance.getMetrics');

    await page.evaluate(() => {
      const root = document.querySelector('diffs-container');
      window.__diffMutations = 0;
      window.__diffObserver = new MutationObserver(records => { window.__diffMutations += records.length; });
      window.__diffObserver.observe(root.shadowRoot, { childList: true, subtree: true, attributes: true, characterData: true });
    });
    const scroll = await page.evaluate(async fullRange => {
      const scroller = document.querySelector('.diff-scroll');
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const frameTimes = [];
      for (let step = 1; step <= 30; step++) {
        const startedAt = performance.now();
        scroller.scrollTop = fullRange
          ? maxScroll * step / 30
          : Math.min(maxScroll, scroller.scrollTop + Math.max(180, scroller.clientHeight * 0.45));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        frameTimes.push(performance.now() - startedAt);
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
      frameTimes.sort((a, b) => a - b);
      return { totalMs: frameTimes.reduce((sum, value) => sum + value, 0), p95FrameMs: frameTimes[Math.ceil(frameTimes.length * 0.95) - 1], maxFrameMs: frameTimes.at(-1), mutations: window.__diffMutations };
    }, scenario.linesPerFile > 2_000);
    const afterMetrics = await cdp.send('Performance.getMetrics');
    const afterHeap = await cdp.send('Runtime.getHeapUsage');
    const afterDom = await cdp.send('Memory.getDOMCounters');
    const diffDomNodes = await page.evaluate(() => document.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('*').length || 0);
    const renderedLines = await page.evaluate(() => document.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-line]').length || 0);

    const switches = [];
    const switchCount = Math.min(5, paths.length - 1);
    for (let index = 0; index < switchCount; index++) {
      const target = paths[index + 1];
      const switchStarted = performance.now();
      await page.locator('.file-row').nth(index + 1).click();
      await page.waitForFunction(path => {
        const root = document.querySelector(`.diff-shell[data-path="${path}"] diffs-container`);
        return root?.shadowRoot?.querySelector('[data-line]') != null;
      }, target, { timeout: 30_000 });
      switches.push(performance.now() - switchStarted);
    }
    if (scenario.linesPerFile > 2_000) {
      const additions = page.locator('diffs-container [data-line]');
      await additions.first().click();
      await page.locator('#review-comment').fill('Single-line selection benchmark');
      await page.getByRole('button', { name: 'Save draft' }).click();
      if (commentPayloads[0]?.position?.new_line == null) throw new Error('Large diff line selection did not preserve its GitLab position');

      const numberColumns = page.locator('diffs-container [data-column-number]');
      const first = await numberColumns.nth(0).boundingBox();
      const third = await numberColumns.nth(2).boundingBox();
      if (!first || !third) throw new Error('Large diff range-selection rows are not mounted');
      await page.mouse.move(first.x + Math.min(first.width / 2, 220), first.y + first.height / 2);
      await page.mouse.down();
      await page.mouse.move(third.x + Math.min(third.width / 2, 220), third.y + third.height / 2, { steps: 4 });
      await page.mouse.up();
      await page.locator('#review-comment').fill('Range selection benchmark');
      await page.getByRole('button', { name: 'Save draft' }).click();
      if (!commentPayloads[1]?.position?.line_range) throw new Error('Large diff range selection did not preserve its GitLab position');
    }
    switches.sort((a, b) => a - b);
    const result = {
      scenario: scenario.name,
      files: scenario.files,
      changedLinesPerFile: scenario.linesPerFile,
      firstVisibleLineMs: Number(firstVisibleLineMs.toFixed(1)),
      scroll30FramesMs: Number(scroll.totalMs.toFixed(1)),
      scrollP95FrameMs: Number(scroll.p95FrameMs.toFixed(1)),
      scrollMaxFrameMs: Number(scroll.maxFrameMs.toFixed(1)),
      diffDomMutationsDuringScroll: scroll.mutations,
      medianFileSwitchMs: switches.length ? Number(switches[Math.floor(switches.length / 2)].toFixed(1)) : null,
      mainThreadHeapUsedMb: Number((afterHeap.usedSize / 1024 / 1024).toFixed(1)),
      mainThreadHeapDeltaMb: Number(((afterHeap.usedSize - beforeHeap.usedSize) / 1024 / 1024).toFixed(1)),
      domNodes: afterDom.nodes,
      domNodeDelta: afterDom.nodes - beforeDom.nodes,
      diffDomNodes,
      renderedLines,
      layoutCountDuringScroll: Number((metric(afterMetrics, 'LayoutCount') - metric(beforeMetrics, 'LayoutCount')).toFixed(0)),
      styleRecalcCountDuringScroll: Number((metric(afterMetrics, 'RecalcStyleCount') - metric(beforeMetrics, 'RecalcStyleCount')).toFixed(0)),
    };
    if (result.firstVisibleLineMs > 10_000) thresholdFailures.push(`${scenario.name}: first visible line exceeded 10 s`);
    if (result.scrollP95FrameMs > 250 || result.scroll30FramesMs > 10_000) thresholdFailures.push(`${scenario.name}: scroll exceeded 250 ms p95 or 10 s total`);
    if ((result.medianFileSwitchMs ?? 0) > 5_000) thresholdFailures.push(`${scenario.name}: file switch exceeded 5 s`);
    if (result.domNodes > 15_000 || result.mainThreadHeapUsedMb > 1_000) thresholdFailures.push(`${scenario.name}: main-thread DOM or heap exceeded its memory budget`);
    results.push(result);
    await context.close();
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ browser: 'Chromium headless, production Nitro server', thresholds: { firstVisibleLineMs: 10_000, scrollP95FrameMs: 250, scroll30FramesMs: 10_000, medianFileSwitchMs: 5_000, domNodes: 15_000, mainThreadHeapMb: 1_000 }, thresholdFailures, results }, null, 2));
  if (thresholdFailures.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
}

function metric(response, name) {
  return response.metrics.find(entry => entry.name === name)?.value || 0;
}
