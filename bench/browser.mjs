import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright-core';

const root = new URL('../', import.meta.url).pathname;
const scenarios = [
  { name: 'forty-small-and-medium-files', lineCounts: [...Array(20).fill(60), ...Array(20).fill(300)] },
  { name: 'two-large-single-hunk-files', lineCounts: [20_000, 20_000] },
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
    const paths = scenario.lineCounts.map((_, index) => `src/file-${String(index + 1).padStart(3, '0')}.ts`);
    const maxLinesPerFile = Math.max(...scenario.lineCounts);
    const patch = (_path, lineCount) => `@@ -0,0 +1,${lineCount} @@\n${Array.from({ length: lineCount }, (_, index) => `+export const item${index} = ${index};`).join('\n')}\n`;
    const mr = { id: 77, iid: 7, title: scenario.name, description: '', state: 'opened', web_url: 'https://gitlab.example/group/app/-/merge_requests/7', source_branch: 'bench', target_branch: 'main', sha: 'head', diff_refs: { base_sha: 'base', head_sha: 'head', start_sha: 'start' }, source_project_id: 2, target_project_id: 2, reviewers: [{ id: 5, username: 'bench', name: 'Benchmark', state: 'unreviewed' }], author: { username: 'bench', name: 'Benchmark' } };
    const data = { mr, user: { id: 5, username: 'bench', name: 'Benchmark' }, project: { id: 2, path: 'group/app' }, discussions: [], draftNotes: [], codeowners: [{ pattern: 'src/file-001.ts', owners: ['@reviewer-team'] }], diffs: paths.map((path, index) => ({ old_path: path, new_path: path, old_id: 'old-blob', new_id: 'new-blob', diff: patch(path, scenario.lineCounts[index]), new_file: true, deleted_file: false, renamed_file: false, identity: path })) };
    const context = await browser.newContext();
    const page = await context.newPage();
    const commentPayloads = [];
    const apiActions = [];
    await page.addInitScript(() => {
      window.__longTasks = [];
      if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        new PerformanceObserver(list => window.__longTasks.push(...list.getEntries().map(entry => entry.duration))).observe({ type: 'longtask', buffered: true });
      }
    });
    page.on('pageerror', error => errors.push(`${scenario.name}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${scenario.name}: ${message.text()}`); });
    await context.route('**/api/gitlab', route => {
      const request = route.request().postDataJSON();
      apiActions.push(request.action);
      if (request.action === 'comment') commentPayloads.push(request.payload);
      const response = request.action === 'bootstrap' ? { ...data, diffs: data.diffs.map(file => ({ ...file, identity: null })) }
        : request.action === 'file-identities' ? { identities: Object.fromEntries(data.diffs.filter(file => request.payload.paths.includes(file.new_path)).map(file => [file.new_path, file.identity])) }
          : request.action === 'verify-owners' ? { codeowners: data.codeowners, ownerStatus: { '@reviewer-team': true } } : { mr, discussions: [], draftNotes: [] };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
    });

    const started = performance.now();
    await page.goto(`${baseUrl}/?mr=${encodeURIComponent(mr.web_url)}`);
    await page.locator(`.diff-shell[data-path="${paths[0]}"] diffs-container`).waitFor({ timeout: 30_000 });
    await page.evaluate(() => {
      const scrollRoot = document.querySelector('.diff-shell.code-view') || document.querySelector('.diff-scroll');
      const root = document.querySelector('diffs-container');
      window.__diffMutations = 0;
      window.__lastDiffMutationAt = performance.now();
      window.__diffObservers = [scrollRoot, root.shadowRoot].map(target => {
        const observer = new MutationObserver(records => {
          window.__diffMutations += records.length;
          window.__lastDiffMutationAt = performance.now();
        });
        observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
        return observer;
      });
    });
    try {
      await page.waitForFunction(path => {
        const root = document.querySelector(`.diff-shell[data-path="${path}"] diffs-container`);
        return root?.shadowRoot?.querySelector('[data-line]') != null;
      }, paths[0], { timeout: 30_000 });
    } catch (error) {
      const state = await page.evaluate(() => ({ title: document.title, text: document.body.innerText.slice(0, 500), path: document.querySelector('.diff-shell')?.getAttribute('data-path'), shell: document.querySelector('.diff-shell')?.innerHTML.slice(0, 500), resources: performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/gitlab')).map(entry => ({ start: entry.startTime, duration: entry.duration })) }));
      throw new Error(`${scenario.name}: first line did not render (${JSON.stringify(state)}); ${error.message}`, { cause: error });
    }
    const firstLineTiming = await page.evaluate(() => ({
      firstLineAt: performance.now(),
      bootstrapStart: performance.getEntriesByType('resource').find(entry => entry.name.endsWith('/api/gitlab'))?.startTime || 0,
    }));
    const firstVisibleLineMs = performance.now() - started;
    const firstLineAfterBootstrapMs = firstLineTiming.bootstrapStart ? firstLineTiming.firstLineAt - firstLineTiming.bootstrapStart : firstVisibleLineMs;
    await page.waitForFunction(() => { const input = document.querySelector('.filter-toggle input'); return input && !input.disabled; }, undefined, { timeout: 30_000 });
    if (!apiActions.includes('verify-owners')) throw new Error(`${scenario.name}: assigned reviewer ownership was not checked`);
    const ownerEligibilityMs = performance.now() - started;
    const onlyMine = page.getByRole('checkbox', { name: 'Only my files' });
    await onlyMine.check();
    await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 1, undefined, { timeout: 15_000 });
    const positivelyOwnedFilesShown = await page.locator('.file-row').count();
    await onlyMine.uncheck();
    await page.waitForFunction(expected => document.querySelectorAll('.file-row').length === expected, paths.length);
    const highlightSettled = await page.evaluate(async () => {
      const startedAt = performance.now();
      return new Promise(resolve => {
        const check = () => performance.now() - startedAt >= 1_000 && performance.now() - window.__lastDiffMutationAt >= 300
          ? resolve({ ms: performance.now() - startedAt, settled: true })
          : performance.now() - startedAt >= 10_000
            ? resolve({ ms: performance.now() - startedAt, settled: false })
          : setTimeout(check, 50);
        check();
      });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const beforeHeap = await cdp.send('Runtime.getHeapUsage');
    const beforeDom = await cdp.send('Memory.getDOMCounters');
    const beforeMetrics = await cdp.send('Performance.getMetrics');
    const heapSamples = [beforeHeap.usedSize];
    if (process.env.PROFILE_SCROLL === '1') {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 1_000 });
      await cdp.send('Profiler.start');
    }
    await page.evaluate(() => { window.__diffMutations = 0; window.__longTaskStart = window.__longTasks.length; });
    const scroll = await page.evaluate(async fullRange => {
      const scroller = document.querySelector('.diff-shell.code-view') || document.querySelector('.diff-scroll');
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const frameTimes = [];
      const roundTotals = [];
      for (let round = 0; round < 3; round++) {
        scroller.scrollTop = 0;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const roundStarted = performance.now();
        for (let step = 1; step <= 30; step++) {
          const startedAt = performance.now();
          scroller.scrollTop = fullRange
            ? maxScroll * step / 30
            : Math.min(maxScroll, scroller.scrollTop + Math.max(180, scroller.clientHeight * 0.45));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          frameTimes.push(performance.now() - startedAt);
        }
        roundTotals.push(performance.now() - roundStarted);
      }
      frameTimes.sort((a, b) => a - b);
      roundTotals.sort((a, b) => a - b);
      return { median30FramesMs: roundTotals[1], p95FrameMs: frameTimes[Math.ceil(frameTimes.length * 0.95) - 1], maxFrameMs: frameTimes.at(-1), mutations: window.__diffMutations };
    }, maxLinesPerFile > 2_000);
    await page.waitForTimeout(50);
    const longTasks = await page.evaluate(() => window.__longTasks.slice(window.__longTaskStart));
    const afterMetrics = await cdp.send('Performance.getMetrics');
    const afterHeap = await cdp.send('Runtime.getHeapUsage');
    const afterDom = await cdp.send('Memory.getDOMCounters');
    let cpuProfileTop = [];
    if (process.env.PROFILE_SCROLL === '1') {
      const { profile } = await cdp.send('Profiler.stop');
      const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
      const weightedSamples = new Map();
      for (let index = 0; index < profile.samples.length; index++) {
        const nodeId = profile.samples[index];
        weightedSamples.set(nodeId, (weightedSamples.get(nodeId) || 0) + (profile.timeDeltas[index] || 0));
      }
      cpuProfileTop = [...weightedSamples].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, microseconds]) => ({
        function: nodes.get(id)?.functionName || '(anonymous)',
        url: nodes.get(id)?.url || '',
        line: nodes.get(id)?.lineNumber ?? -1,
        sampledMs: Number((microseconds / 1_000).toFixed(1)),
      }));
      await cdp.send('Profiler.disable');
    }
    const diffDomNodes = await page.evaluate(() => document.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('*').length || 0);
    const renderedLines = await page.evaluate(() => document.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-line]').length || 0);
    await page.evaluate(() => { window.__diffMutations = 0; });
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.__diffMutations = 0; });
    await page.getByRole('button', { name: '↻ Refresh' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.top-actions button')].some(button => button.textContent?.trim() === '↻ Refresh' && !button.disabled));
    await page.waitForTimeout(300);
    const discussionRefreshMutations = await page.evaluate(() => window.__diffMutations);

    const switches = [];
    const switchIndexes = [...new Set([0.1, 0.25, 0.5, 0.75, 1].map(fraction => Math.min(paths.length - 1, Math.max(1, Math.ceil(paths.length * fraction) - 1))))];
    for (const index of switchIndexes) {
      const target = paths[index];
      const switchStarted = performance.now();
      await page.locator('.file-row').nth(index).click();
      await page.waitForFunction(path => {
        const root = document.querySelector(`.diff-shell[data-path="${path}"] diffs-container`);
        return root?.shadowRoot?.querySelector('[data-line]') != null;
      }, target, { timeout: 30_000 });
      switches.push(performance.now() - switchStarted);
      heapSamples.push((await cdp.send('Runtime.getHeapUsage')).usedSize);
    }
    if (maxLinesPerFile > 2_000) {
      for (const mode of ['Unified', 'Split']) {
        await page.getByRole('button', { name: mode, exact: true }).click();
        await page.waitForFunction(path => {
          const root = document.querySelector(`.diff-shell[data-path="${path}"] diffs-container`);
          return root?.shadowRoot?.querySelector('[data-line]') != null;
        }, paths.at(-1));
      }
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
      files: paths.length,
      changedLinesPerFile: { min: Math.min(...scenario.lineCounts), max: maxLinesPerFile },
      totalChangedLines: scenario.lineCounts.reduce((sum, value) => sum + value, 0),
      firstVisibleLineMs: Number(firstVisibleLineMs.toFixed(1)),
      firstLineAfterBootstrapMs: Number(firstLineAfterBootstrapMs.toFixed(1)),
      ownerEligibilityMs: Number(ownerEligibilityMs.toFixed(1)),
      positivelyOwnedFilesShown,
      highlightSettledMs: Number(highlightSettled.ms.toFixed(1)),
      highlightSettled: highlightSettled.settled,
      scroll30FramesMs: Number(scroll.median30FramesMs.toFixed(1)),
      scrollP95FrameMs: Number(scroll.p95FrameMs.toFixed(1)),
      scrollMaxFrameMs: Number(scroll.maxFrameMs.toFixed(1)),
      diffDomMutationsDuringScroll: scroll.mutations,
      medianFileSwitchMs: switches.length ? Number(switches[Math.floor(switches.length / 2)].toFixed(1)) : null,
      mainThreadHeapUsedMb: Number((afterHeap.usedSize / 1024 / 1024).toFixed(1)),
      mainThreadHeapPeakMb: Number((Math.max(...heapSamples, afterHeap.usedSize) / 1024 / 1024).toFixed(1)),
      mainThreadHeapDeltaMb: Number(((Math.max(...heapSamples, afterHeap.usedSize) - beforeHeap.usedSize) / 1024 / 1024).toFixed(1)),
      domNodes: afterDom.nodes,
      domNodeDelta: afterDom.nodes - beforeDom.nodes,
      diffDomNodes,
      renderedLines,
      layoutCountDuringScroll: Number((metric(afterMetrics, 'LayoutCount') - metric(beforeMetrics, 'LayoutCount')).toFixed(0)),
      styleRecalcCountDuringScroll: Number((metric(afterMetrics, 'RecalcStyleCount') - metric(beforeMetrics, 'RecalcStyleCount')).toFixed(0)),
      longTaskCountDuringScroll: longTasks.length,
      maxLongTaskMsDuringScroll: Number(Math.max(0, ...longTasks).toFixed(1)),
      diffDomMutationsDuringDiscussionRefresh: discussionRefreshMutations,
      ...(cpuProfileTop.length ? { cpuProfileTop } : {}),
    };
    if (result.firstLineAfterBootstrapMs > 3_000) thresholdFailures.push(`${scenario.name}: first line exceeded 3 s after bootstrap started`);
    if (!result.highlightSettled) thresholdFailures.push(`${scenario.name}: highlighter did not settle within 10 s`);
    if (result.scrollP95FrameMs > 300 || result.scroll30FramesMs > 10_000) thresholdFailures.push(`${scenario.name}: scroll exceeded 300 ms p95 or 10 s total`);
    if ((result.medianFileSwitchMs ?? 0) > 2_500) thresholdFailures.push(`${scenario.name}: file switch exceeded 2.5 s`);
    if (result.diffDomNodes > 12_000 || result.mainThreadHeapPeakMb > 256) thresholdFailures.push(`${scenario.name}: rendered diff DOM or heap exceeded its memory budget`);
    if (result.maxLongTaskMsDuringScroll > 500) thresholdFailures.push(`${scenario.name}: a main-thread long task exceeded 500 ms during scrolling`);
    if (result.diffDomMutationsDuringDiscussionRefresh !== 0) thresholdFailures.push(`${scenario.name}: discussion polling mutated the unchanged diff DOM`);
    results.push(result);
    await context.close();
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ browser: 'Chromium headless, production Nitro server', thresholds: { firstLineAfterBootstrapMs: 3_000, scrollP95FrameMs: 300, scroll30FramesMs: 10_000, medianFileSwitchMs: 2_500, diffDomNodes: 12_000, mainThreadHeapMb: 256, maxLongTaskMs: 500 }, thresholdFailures, results }, null, 2));
  if (thresholdFailures.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
}

function metric(response, name) {
  return response.metrics.find(entry => entry.name === name)?.value || 0;
}
