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

test('loads and refreshes draft notes and uses GitLab-supported MR and draft-note operations', async t => {
  const originalFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'review-master-api-'));
  const config = join(directory, 'accounts.json');
  await writeFile(config, JSON.stringify([{ host: 'https://gitlab.example', token: 'test-token', username: 'reviewer' }]), { mode: 0o600 });
  process.env.REVIEW_MASTER_CONFIG = config;
  t.after(async () => { delete process.env.REVIEW_MASTER_CONFIG; await rm(directory, { recursive: true, force: true }); });

  const requests = [];
  const draft = { id: 31, note: 'Remote draft', discussion_id: null, position: null };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, method: init.method || 'GET', body: init.body && JSON.parse(init.body) });
    const payload = url.pathname.endsWith('/merge_requests/7') ? { id: 77, iid: 7, title: 'Draft MR', draft: true, sha: 'head', diff_refs: {} }
      : url.pathname.endsWith('/api/v4/user') ? { id: 5, username: 'reviewer', name: 'Reviewer' }
      : url.pathname.endsWith('/api/v4/projects/group%2Fapp') ? { id: 2, path_with_namespace: 'group/app', namespace: {} }
      : url.pathname.endsWith('/diffs') ? [{ old_path: 'a.ts', new_path: 'a.ts', diff: '', new_file: false, deleted_file: false, renamed_file: false }]
      : url.pathname.endsWith('/discussions') ? []
      : url.pathname.includes('/draft_notes') && !url.pathname.endsWith('/bulk_publish') ? [draft]
      : null;
    if (url.pathname.includes('/repository/files/')) return new Response('', { status: 404 });
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
  const refreshed = await call('refresh');
  assert.deepEqual(refreshed.draftNotes.map(item => item.id), [31]);
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
