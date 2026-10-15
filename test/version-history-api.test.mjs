import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

globalThis.createError = options => Object.assign(new Error(options.statusMessage), options);
globalThis.defineEventHandler = handler => handler;
globalThis.readBody = event => event.body;
globalThis.getRequestHeader = (event, name) => event.headers?.[name];
const handler = (await import('../server/api/gitlab.post.ts')).default;

const versions = [
  { id: 103, created_at: '2026-10-03T12:00:00Z', head_commit_sha: 'amended-v3', base_commit_sha: 'target-base', start_commit_sha: 'target-base', state: 'collected' },
  { id: 102, created_at: '2026-10-02T12:00:00Z', head_commit_sha: 'amended-v2', base_commit_sha: 'target-base', start_commit_sha: 'target-base', state: 'collected' },
  { id: 101, created_at: '2026-10-01T12:00:00Z', head_commit_sha: 'initial-v1', base_commit_sha: 'target-base', start_commit_sha: 'target-base', state: 'collected' },
];
const diff = (path, content) => ({ old_path: path, new_path: path, diff: content, new_file: false, deleted_file: false, renamed_file: false });

async function setup(t, { timeout = false, noChanges = false, withoutFiles = [], officialLine = 1 } = {}) {
  const listedVersions = versions.map(version => withoutFiles.includes(version.id)
    ? { ...version, state: 'without_files' }
    : version);
  const originalFetch = globalThis.fetch;
  const previousConfig = process.env.REVIEW_MASTER_CONFIG;
  const directory = await mkdtemp(join(tmpdir(), 'mergepeek-version-api-'));
  const config = join(directory, 'accounts.json');
  await writeFile(config, JSON.stringify([{ host: 'https://gitlab.example', token: 'test-token', username: 'reviewer' }]), { mode: 0o600 });
  process.env.REVIEW_MASTER_CONFIG = config;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, method: init.method || 'GET' });
    if (url.pathname.endsWith('/api/v4/user')) return new Response(JSON.stringify({ id: 5, username: 'reviewer' }), { status: 200 });
    if (url.pathname.endsWith('/merge_requests/7/versions')) return new Response(JSON.stringify(listedVersions), { status: 200 });
    if (url.pathname.endsWith('/merge_requests/7')) return new Response(JSON.stringify({
      id: 77, iid: 7, title: 'Amended MR', target_branch: 'main', source_branch: 'feature',
      sha: 'amended-v3', diff_refs: { base_sha: 'target-base', head_sha: 'amended-v3', start_sha: 'target-base' },
    }), { status: 200 });
    const version = url.pathname.match(/\/versions\/(\d+)$/);
    if (version) {
      const metadata = listedVersions.find(item => item.id === Number(version[1]));
      const cumulativeDiff = diff('src/app.ts', `@@ -${officialLine} +${officialLine} @@\n-previous cumulative state\n+full MR state at ${metadata.head_commit_sha}\n`);
      return new Response(JSON.stringify({ ...metadata, diffs: metadata.state === 'without_files' ? [] : [cumulativeDiff] }), { status: 200 });
    }
    if (url.pathname.endsWith('/repository/compare')) {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      return new Response(JSON.stringify({
        compare_timeout: timeout,
        diffs: noChanges ? [] : [diff('src/app.ts', `@@ -1 +1 @@\n-${from}\n+${to}\n`)],
      }), { status: 200 });
    }
    if (url.pathname.endsWith('/discussions') || url.pathname.endsWith('/draft_notes')) return new Response('[]', { status: 200 });
    return new Response('{}', { status: 200 });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (previousConfig === undefined) delete process.env.REVIEW_MASTER_CONFIG;
    else process.env.REVIEW_MASTER_CONFIG = previousConfig;
    await rm(directory, { recursive: true, force: true });
  });
  return {
    requests,
    call: (action, payload) => handler({
      headers: { host: '127.0.0.1:43210' },
      body: { mrUrl: 'https://gitlab.example/group/app/-/merge_requests/7', action, payload },
    }),
  };
}

test('bootstrap selects the latest push and compares adjacent snapshots after amend or force-push', async t => {
  const { call, requests } = await setup(t);
  const loaded = await call('bootstrap');

  assert.equal(loaded.selectedVersionId, 103);
  assert.equal(loaded.versionIsLatest, true);
  assert.deepEqual(loaded.commentRefs, { base_sha: 'target-base', head_sha: 'amended-v3', start_sha: 'target-base' }, 'inline positions use the selected version refs from GitLab');
  assert.deepEqual(loaded.commentableLines, [{ old_path: 'src/app.ts', new_path: 'src/app.ts', old_lines: [1], new_lines: [1] }], 'only selected delta lines present in the official version diff are commentable');
  assert.deepEqual(loaded.versions.map(version => version.id), [103, 102, 101], 'history stays newest first');
  assert.equal(loaded.mr.sha, 'amended-v3');
  assert.equal(loaded.mr.diff_refs.base_sha, 'amended-v2', 'the selected incremental diff uses its prior snapshot as the base');
  assert.match(loaded.diffs[0].diff, /-amended-v2\n\+amended-v3/, 'the rendered diff is between actual push heads, not cumulative patch text');
  const compare = requests.find(request => request.url.pathname.endsWith('/repository/compare'));
  assert.equal(compare.url.searchParams.get('from'), 'amended-v2');
  assert.equal(compare.url.searchParams.get('to'), 'amended-v3');
  assert.equal(compare.url.searchParams.get('straight'), 'true');
  assert.ok(!requests.some(request => request.url.pathname.endsWith('/merge_requests/7/diffs')), 'the current cumulative diff is not substituted for the selected push delta');
});

test('selecting an older push loads that version delta; an incomplete compare fails safely', async t => {
  const { call, requests } = await setup(t);
  const older = await call('version-diff', { versionId: 102 });
  const compare = requests.filter(request => request.url.pathname.endsWith('/repository/compare')).at(-1);

  assert.equal(older.selectedVersionId, 102);
  assert.equal(older.mr.sha, 'amended-v2');
  assert.equal(compare.url.searchParams.get('from'), 'initial-v1');
  assert.equal(compare.url.searchParams.get('to'), 'amended-v2');
  assert.match(older.diffs[0].diff, /-initial-v1\n\+amended-v2/);

  const compareCount = requests.filter(request => request.url.pathname.endsWith('/repository/compare')).length;
  const initial = await call('version-diff', { versionId: 101 });
  assert.equal(initial.versionIsInitial, true);
  assert.equal(initial.mr.sha, 'initial-v1');
  assert.equal(initial.mr.diff_refs.base_sha, 'target-base');
  assert.match(initial.diffs[0].diff, /full MR state at initial-v1/, 'the earliest push keeps the complete original MR change');
  assert.equal(requests.filter(request => request.url.pathname.endsWith('/repository/compare')).length, compareCount, 'the initial push uses GitLab’s version snapshot against its MR base');
  await assert.rejects(call('version-diff', { versionId: 999 }), error => error.statusCode === 404 && /no longer available/i.test(error.statusMessage));

  const incomplete = await setup(t, { timeout: true });
  await assert.rejects(incomplete.call('version-diff', { versionId: 103 }), error => {
    assert.equal(error.statusCode, 502);
    assert.match(error.statusMessage, /complete.*version diff/i);
    return true;
  });
});

test('a push with no net file changes stays empty instead of falling back to the current MR diff', async t => {
  const { call } = await setup(t, { noChanges: true });
  const result = await call('version-diff', { versionId: 103 });
  assert.deepEqual(result.diffs, []);
  assert.equal(result.versionIsInitial, false);
});

test('does not expose guessed inline positions when the current MR diff cannot match a delta line', async t => {
  const { call } = await setup(t, { officialLine: 25 });
  const latest = await call('bootstrap');

  assert.equal(latest.versionIsLatest, true);
  assert.deepEqual(latest.commentableLines, [{ old_path: 'src/app.ts', new_path: 'src/app.ts', old_lines: [], new_lines: [] }]);

  const historical = await call('version-diff', { versionId: 102 });
  assert.equal(historical.versionIsLatest, false);
  assert.deepEqual(historical.commentableLines, [], 'historical deltas never reuse current inline coordinates');
});

test('versions without stored files recover their exact diff from the version SHAs', async t => {
  const { call, requests } = await setup(t, { withoutFiles: [102, 101] });

  const older = await call('version-diff', { versionId: 102 });
  const olderCompare = requests.filter(request => request.url.pathname.endsWith('/repository/compare')).at(-1);
  assert.equal(older.selectedVersionId, 102);
  assert.equal(olderCompare.url.searchParams.get('from'), 'initial-v1');
  assert.equal(olderCompare.url.searchParams.get('to'), 'amended-v2');
  assert.match(older.diffs[0].diff, /-initial-v1\n\+amended-v2/, 'a missing stored snapshot must use the selected push delta');

  const initial = await call('version-diff', { versionId: 101 });
  const initialCompare = requests.filter(request => request.url.pathname.endsWith('/repository/compare')).at(-1);
  assert.equal(initial.versionIsInitial, true);
  assert.equal(initial.mr.diff_refs.base_sha, 'target-base');
  assert.equal(initialCompare.url.searchParams.get('from'), 'target-base');
  assert.equal(initialCompare.url.searchParams.get('to'), 'initial-v1');
  assert.match(initial.diffs[0].diff, /-target-base\n\+initial-v1/, 'the first push compares its base directly with its head');
});
