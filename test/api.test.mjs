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

test('allows an explicitly trusted host but still rejects cross-origin requests', async t => {
  const originalFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'mergepeek-host-'));
  const config = join(directory, 'accounts.json');
  await writeFile(config, JSON.stringify([{ host: 'https://gitlab.example', token: 'test-token', username: 'reviewer' }]), { mode: 0o600 });
  const previous = {
    config: process.env.REVIEW_MASTER_CONFIG,
    allowed: process.env.REVIEW_MASTER_ALLOWED_HOSTS,
  };
  process.env.REVIEW_MASTER_CONFIG = config;
  process.env.REVIEW_MASTER_ALLOWED_HOSTS = '100.111.167.123';
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 5, username: 'reviewer' }), { status: 200 });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    previous.config === undefined ? delete process.env.REVIEW_MASTER_CONFIG : process.env.REVIEW_MASTER_CONFIG = previous.config;
    previous.allowed === undefined ? delete process.env.REVIEW_MASTER_ALLOWED_HOSTS : process.env.REVIEW_MASTER_ALLOWED_HOSTS = previous.allowed;
    await rm(directory, { recursive: true, force: true });
  });

  const event = origin => ({
    headers: { host: '100.111.167.123:4173', origin },
    body: { mrUrl: 'https://gitlab.example/group/app/-/merge_requests/7', action: 'invalid' },
  });
  await assert.rejects(handler(event('http://100.111.167.123:4173')), error => error.statusCode === 400 && error.statusMessage === 'Unknown GitLab action');
  await assert.rejects(handler(event('http://other.example')), error => error.statusCode === 403 && error.statusMessage === 'Cross-origin request rejected');
});

test('loads and refreshes draft notes and uses GitLab-supported MR and draft-note operations', async t => {
  const originalFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'review-master-api-'));
  const config = join(directory, 'accounts.json');
  await writeFile(config, JSON.stringify([{ host: 'https://gitlab.example', token: 'test-token', username: 'reviewer' }]), { mode: 0o600 });
  process.env.REVIEW_MASTER_CONFIG = config;
  t.after(async () => { delete process.env.REVIEW_MASTER_CONFIG; await rm(directory, { recursive: true, force: true }); });

  const requests = [];
  const draft = { id: 31, note: 'Remote draft', discussion_id: null, position: null };
  const codeownersFile = '[Maintainers] @reviewer another@example.com @nested/team @missing-group\n*\n!docs/private/**\n\n[Unrelated]\nprivate/** @unused/group\n';
  let currentSha = 'head';
  let currentDiscussions = [];
  let cliLogs = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk) {
    cliLogs += String(chunk);
    return true;
  };
  process.env.REVIEW_MASTER_CLI = '1';
  t.after(() => { process.stdout.write = originalWrite; delete process.env.REVIEW_MASTER_CLI; });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, method: init.method || 'GET', body: init.body && JSON.parse(init.body) });
    if (url.pathname.endsWith('/groups/nested%2Fteam/members/all/5')) return new Response(JSON.stringify({ id: 5, access_level: 30 }), { status: 200 });
    if (url.pathname.endsWith('/groups/missing-group/members/all/5')) return new Response('', { status: 404 });
    const payload = url.pathname.endsWith('/merge_requests/7') ? { id: 77, iid: 7, title: 'Draft MR', draft: true, sha: currentSha, diff_refs: {} }
      : url.pathname.endsWith('/api/v4/user') ? { id: 5, username: 'reviewer', name: 'Reviewer', email: 'reviewer@example.com' }
      : url.pathname.endsWith('/api/v4/projects/group%2Fapp') ? { id: 2, path_with_namespace: 'group/app', namespace: {} }
      : url.pathname.endsWith('/diffs') ? [{ old_path: 'a.ts', new_path: 'a.ts', diff: '', new_file: false, deleted_file: false, renamed_file: false }]
      : url.pathname.endsWith('/discussions') ? currentDiscussions
      : url.pathname.includes('/draft_notes') && !url.pathname.endsWith('/bulk_publish') ? [draft]
      : null;
    if (url.pathname.includes('/repository/files/')) {
      if (url.pathname.includes('.gitlab%2FCODEOWNERS')) return new Response(codeownersFile);
      return new Response('', { status: 404 });
    }
    if (url.pathname.includes('/draft_notes/') && ['PUT', 'DELETE', 'POST'].includes(init.method)) return new Response('{}', { status: 200 });
    if (url.pathname.endsWith('/approve') || url.pathname.endsWith('/unapprove') || url.pathname.endsWith('/notes')) return new Response('{}', { status: 200 });
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const call = (action, payload) => handler({
    headers: { host: '127.0.0.1:43210' },
    body: { mrUrl: 'https://gitlab.example/group/app/-/merge_requests/7', action, payload },
  });

  const loaded = await call('bootstrap');
  assert.deepEqual(loaded.draftNotes.map(item => item.id), [31]);
  assert.equal(loaded.ownerWarning, undefined, 'a wildcard fallback and exclusions in a real GitLab CODEOWNERS file do not disable ownership parsing');
  assert.ok(loaded.codeowners.some(rule => rule.exclude && rule.pattern === 'docs/private/**'));
  assert.equal(loaded.ownerStatus['@reviewer'], true);
  assert.equal(loaded.ownerStatus['another@example.com'], false, 'another email owner is not an unverifiable match');
  assert.equal(loaded.ownerStatus['@nested/team'], true, 'inherited group membership is checked by user ID');
  assert.equal(loaded.ownerStatus['@missing-group'], false, 'a 404 membership response means the reviewer is not an owner');
  assert.ok(Object.values(loaded.ownerStatus).every(status => status !== null), 'known non-matches do not trigger an unknown-owner warning');
  assert.ok(requests.some(request => request.path.endsWith('/groups/nested%2Fteam/members/all/5')));
  assert.ok(!requests.some(request => request.path.includes('/groups/unused%2Fgroup/members/all/5')), 'only owners that apply to changed paths are checked');
  const refreshed = await call('refresh');
  assert.deepEqual(refreshed.draftNotes.map(item => item.id), [31]);
  assert.equal(cliLogs, '', 'initial load and unchanged refresh do not announce existing activity');
  currentSha = '12345678abcdef';
  currentDiscussions = [{ notes: [{ id: 41, body: 'private comment' }] }];
  await call('refresh');
  assert.equal(cliLogs, 'MergePeek: new commit 12345678\nMergePeek: 1 new comment\n');
  await call('refresh');
  assert.equal(cliLogs, 'MergePeek: new commit 12345678\nMergePeek: 1 new comment\n', 'unchanged polling does not repeat logs');
  assert.ok(!cliLogs.includes('private comment'));
  await call('ready');
  await call('approve');
  await call('unapprove');
  await call('request-changes', { body: 'Please add a regression test.' });
  await call('comment', { body: 'Draft inline note', draft: true });
  await call('edit-draft-note', { draftNoteId: 31, note: 'Edited' });
  await call('delete-draft-note', { draftNoteId: 31 });
  await call('publish-drafts');

  assert.ok(requests.some(request => request.method === 'POST' && request.path.endsWith('/notes') && request.body?.body === '/ready'), 'Mark ready is a documented /ready quick action note');
  assert.ok(!requests.some(request => request.path.endsWith('/merge_requests/7') && request.method === 'PUT' && request.body?.draft === false), 'draft:false is not used as an undocumented toggle');
  assert.ok(requests.some(request => request.method === 'POST' && request.path.endsWith('/merge_requests/7/approve')));
  assert.ok(requests.some(request => request.method === 'POST' && request.path.endsWith('/merge_requests/7/unapprove')));
  assert.ok(requests.some(request => request.method === 'POST' && request.path.endsWith('/merge_requests/7/notes') && request.body?.body.endsWith('/submit_review requested_changes')));
  assert.ok(requests.some(request => request.method === 'POST' && request.path.endsWith('/draft_notes') && request.body?.note === 'Draft inline note'));
  assert.ok(requests.some(request => request.method === 'PUT' && request.path.endsWith('/draft_notes/31') && request.body?.note === 'Edited'));
  assert.ok(requests.some(request => request.method === 'DELETE' && request.path.endsWith('/draft_notes/31')));
  assert.ok(requests.some(request => request.method === 'POST' && request.path.endsWith('/draft_notes/bulk_publish')));
});
