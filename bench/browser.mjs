import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright-core';

const lineCount = 20_000;
const portServer = createServer();
await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
const child = spawn(process.execPath, ['.output/server/index.mjs'], {
  cwd: new URL('../', import.meta.url).pathname,
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port) },
});
const errors = [];
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

  const patch = path => `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lineCount} @@\n${Array.from({ length: lineCount }, (_, index) => `+export const item${index} = ${index};`).join('\n')}\n`;
  const mr = { id: 77, iid: 7, title: '20k line browser benchmark', description: '', state: 'opened', web_url: 'https://gitlab.example/group/app/-/merge_requests/7', source_branch: 'bench', target_branch: 'main', sha: 'head', source_project_id: 2, target_project_id: 2, author: { username: 'bench', name: 'Benchmark' } };
  const data = { mr, user: { id: 5, username: 'bench', name: 'Benchmark' }, project: { id: 2, path: 'group/app' }, discussions: [], draftNotes: [], codeowners: [], diffs: ['src/first.ts', 'src/second.ts'].map(path => ({ old_path: path, new_path: path, diff: patch(path), new_file: true, deleted_file: false, renamed_file: false, identity: path })) };
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/api/gitlab', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().postDataJSON().action === 'bootstrap' ? data : { mr, discussions: [], draftNotes: [] }) }));
  await page.goto(baseUrl);
  await page.getByRole('textbox', { name: 'Merge request URL' }).waitFor();
  const started = performance.now();
  await page.getByRole('textbox', { name: 'Merge request URL' }).fill(mr.web_url);
  await page.getByRole('button', { name: 'Open review' }).click();
  try { await page.waitForFunction(() => document.querySelector('.diff-shell[data-path="src/first.ts"] diffs-container')?.shadowRoot?.children.length > 0, undefined, { timeout: 15_000 }); }
  catch (error) {
    const state = await page.evaluate(() => ({ heading: document.querySelector('.mr-heading')?.textContent, error: document.querySelector('[role="alert"]')?.textContent, shell: document.querySelector('.diff-shell')?.outerHTML.slice(0, 500), rows: document.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('*').length || 0 }));
    throw new Error(`Diff rendering timed out: ${JSON.stringify({ state, errors })}`, { cause: error });
  }
  const firstRenderMs = performance.now() - started;
  const initial = await page.evaluate(() => ({ nodes: document.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('*').length || 0 }));

  const scrollMs = await page.evaluate(async () => {
    const scroller = document.querySelector('.diff-scroll');
    const startedAt = performance.now();
    for (let step = 1; step <= 30; step++) {
      scroller.scrollTop = scroller.scrollHeight * step / 30;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    return performance.now() - startedAt;
  });
  const switches = [];
  for (let index = 0; index < 5; index++) {
    const target = index % 2 === 0 ? 'src/second.ts' : 'src/first.ts';
    const switchStarted = performance.now();
    await page.locator('.file-row').nth(index % 2 === 0 ? 1 : 0).click();
    await page.waitForFunction(path => document.querySelector(`.diff-shell[data-path="${path}"] diffs-container`)?.shadowRoot?.children.length > 0, target, { timeout: 15_000 });
    switches.push(performance.now() - switchStarted);
  }
  switches.sort((a, b) => a - b);
  const fileSwitchMs = switches[Math.floor(switches.length / 2)];
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ changedLinesPerFile: lineCount, files: 2, firstRenderMs: Number(firstRenderMs.toFixed(1)), domNodes: initial.nodes, scroll30FramesMs: Number(scrollMs.toFixed(1)), fileSwitchMs: Number(fileSwitchMs.toFixed(1)), browser: 'Chromium headless, production Nitro server' }, null, 2));
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
}
