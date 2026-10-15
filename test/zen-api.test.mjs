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
const mrUrl = 'https://gitlab.example/group/app/-/merge_requests/7';
const inspectedSha = 'a'.repeat(40);

test('lists current MR commits with pagination and loads an authenticated commit diff', async t => {
  const originalFetch = globalThis.fetch;
  const originalConfig = process.env.REVIEW_MASTER_CONFIG;
  const directory = await mkdtemp(join(tmpdir(), 'mergepeek-zen-api-'));
  const config = join(directory, 'accounts.json');
  await writeFile(config, JSON.stringify([{ host: 'https://gitlab.example', token: 'test-token', username: 'reviewer' }]), { mode: 0o600 });
  process.env.REVIEW_MASTER_CONFIG = config;
  const requests = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1).padStart(40, '0'), short_id: `commit-${index + 1}`, title: `Commit ${index + 1}` }));
  const lastCommit = { id: inspectedSha, short_id: inspectedSha.slice(0, 8), title: 'Inspect real commit', author_name: 'Reviewer', committed_date: '2026-10-15T12:00:00Z' };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, authorization: new Headers(init.headers).get('authorization') });
    if (url.pathname.endsWith('/api/v4/user')) return new Response(JSON.stringify({ id: 5, username: 'reviewer', name: 'Reviewer' }), { status: 200 });
    if (url.pathname.endsWith('/merge_requests/7/commits')) {
      return new Response(JSON.stringify(url.searchParams.get('page') === '1' ? firstPage : [lastCommit]), { status: 200 });
    }
    if (url.pathname.endsWith(`/repository/commits/${inspectedSha}/diff`)) {
      return new Response(JSON.stringify([{ old_path: 'src/real.ts', new_path: 'src/real.ts', diff: '@@ -1 +1 @@\n-old\n+new\n', new_file: false, deleted_file: false, renamed_file: false }]), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalConfig === undefined) delete process.env.REVIEW_MASTER_CONFIG;
    else process.env.REVIEW_MASTER_CONFIG = originalConfig;
    await rm(directory, { recursive: true, force: true });
  });
  const call = (action, payload = {}) => handler({ headers: { host: '127.0.0.1:43210' }, body: { mrUrl, action, payload } });

  const commits = await call('mr-commits');
  assert.equal(commits.length, 101, 'both GitLab pages are returned');
  assert.equal(commits.at(-1).id, inspectedSha);
  assert.deepEqual(requests.filter(request => request.url.pathname.endsWith('/merge_requests/7/commits')).map(request => request.url.searchParams.get('page')), ['1', '2']);
  const diff = await call('commit-diff', { sha: inspectedSha });
  assert.equal(diff.commitId, inspectedSha);
  assert.equal(diff.diffs[0].new_path, 'src/real.ts');
  assert.equal(diff.diffs[0].identity, null, 'commit diffs do not acquire review identities');
  assert.ok(requests.filter(request => !request.url.pathname.endsWith('/api/v4/user')).every(request => request.authorization === 'Bearer test-token'));
  assert.ok(requests.some(request => request.url.pathname.endsWith(`/repository/commits/${inspectedSha}/diff`)));
});

test('rejects malformed commit identifiers before requesting a commit diff', async t => {
  const originalFetch = globalThis.fetch;
  const originalConfig = process.env.REVIEW_MASTER_CONFIG;
  const directory = await mkdtemp(join(tmpdir(), 'mergepeek-zen-api-'));
  const config = join(directory, 'accounts.json');
  await writeFile(config, JSON.stringify([{ host: 'https://gitlab.example', token: 'test-token', username: 'reviewer' }]), { mode: 0o600 });
  process.env.REVIEW_MASTER_CONFIG = config;
  const paths = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    return new Response(JSON.stringify({ id: 5, username: 'reviewer', name: 'Reviewer' }), { status: 200 });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalConfig === undefined) delete process.env.REVIEW_MASTER_CONFIG;
    else process.env.REVIEW_MASTER_CONFIG = originalConfig;
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(
    handler({ headers: { host: '127.0.0.1:43210' }, body: { mrUrl, action: 'commit-diff', payload: { sha: 'bad/sha' } } }),
    error => error.statusCode === 400 && /commit SHA/i.test(error.statusMessage),
  );
  assert.equal(paths.some(path => path.includes('/repository/commits/')), false);
});
