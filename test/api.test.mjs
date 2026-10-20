import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

globalThis.createError = options => Object.assign(new Error(options.statusMessage), options);
globalThis.defineEventHandler = handler => handler;
globalThis.readBody = event => event.body;
globalThis.getRequestHeader = (event, name) => event.headers?.[name];
const handler = (await import('../server/api/gitlab.post.ts')).default;

test('accepts non-local hosts without allowlisting but still rejects cross-origin requests', async t => {
  const originalFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'mergepeek-host-'));
  const config = join(directory, 'accounts.json');
  await writeFile(config, JSON.stringify([{ host: 'https://gitlab.example', token: 'test-token', username: 'reviewer' }]), { mode: 0o600 });
  const previous = {
    config: process.env.REVIEW_MASTER_CONFIG,
    allowed: process.env.REVIEW_MASTER_ALLOWED_HOSTS,
  };
  process.env.REVIEW_MASTER_CONFIG = config;
  delete process.env.REVIEW_MASTER_ALLOWED_HOSTS;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 5, username: 'reviewer', email: 'reviewer@example.com' }), { status: 200 });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    previous.config === undefined ? delete process.env.REVIEW_MASTER_CONFIG : process.env.REVIEW_MASTER_CONFIG = previous.config;
    previous.allowed === undefined ? delete process.env.REVIEW_MASTER_ALLOWED_HOSTS : process.env.REVIEW_MASTER_ALLOWED_HOSTS = previous.allowed;
    await rm(directory, { recursive: true, force: true });
  });

  const event = origin => ({
    headers: { host: '186.241.18.236:3001', origin },
    body: { mrUrl: 'https://gitlab.example/group/app/-/merge_requests/7', action: 'invalid' },
  });
  await assert.rejects(handler(event('http://186.241.18.236:3001')), error => error.statusCode === 400 && error.statusMessage === 'Unknown GitLab action');
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
  let codeownersFile = '[Maintainers] @reviewer another@example.com @nested/team @nested/team%developer @nested/team%maintainer @missing-group\n*\n!docs/private/**\n\n[Unrelated]\nprivate/** @unused/group\n';
  let currentSha = 'head';
  const versions = () => [{ id: currentSha === 'head' ? 1 : 2, created_at: '2026-10-01T12:00:00Z', head_commit_sha: currentSha, base_commit_sha: `base-${currentSha}`, start_commit_sha: `base-${currentSha}`, state: 'collected' }];
  let currentDiscussions = [];
  let nestedAccessLevel = 30;
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
    if (url.pathname.endsWith('/groups/nested%2Fteam/members/all/5')) return new Response(JSON.stringify({ id: 5, access_level: nestedAccessLevel }), { status: 200 });
    if (url.pathname.endsWith('/groups/missing-group/members/all/5')) return new Response('', { status: 404 });
    const payload = url.pathname.endsWith('/merge_requests/7') ? { id: 77, iid: 7, title: 'Draft MR', draft: true, sha: currentSha, diff_refs: {} }
      : url.pathname.endsWith('/api/v4/user') ? { id: 5, username: 'reviewer', name: 'Reviewer', email: 'reviewer@example.com' }
      : url.pathname.endsWith('/api/v4/projects/group%2Fapp') ? { id: 2, path_with_namespace: 'group/app', namespace: {} }
      : url.pathname.endsWith('/merge_requests/7/versions') ? versions()
      : url.pathname.endsWith('/versions/1') || url.pathname.endsWith('/versions/2') ? { ...versions()[0], diffs: [{ old_path: 'a.ts', new_path: 'a.ts', diff: '', new_file: false, deleted_file: false, renamed_file: false }] }
      : url.pathname.endsWith('/diffs') ? [{ old_path: 'a.ts', new_path: 'a.ts', diff: '', new_file: false, deleted_file: false, renamed_file: false }]
      : url.pathname.endsWith('/discussions') ? currentDiscussions
      : url.pathname.includes('/draft_notes') && !url.pathname.endsWith('/bulk_publish') ? [draft]
      : null;
    if (url.pathname.includes('/repository/files/')) {
      if (url.pathname.includes('.gitlab%2FCODEOWNERS')) return new Response(codeownersFile);
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'x-gitlab-blob-id': url.pathname.split('/').at(-1) === 'a.ts' ? 'blob-a' : 'blob-b' } });
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
  assert.deepEqual(loaded.draftNotes, [], 'draft notes are left for post-render refresh');
  assert.equal(loaded.diffs[0].identity, null);
  assert.equal(requests.filter(request => request.method === 'HEAD').length, 0, 'bootstrap avoids blocking on file identity requests');
  const identities = await call('file-identities', { paths: ['a.ts', 'b.ts'], sha: 'head' });
  assert.equal(requests.filter(request => request.method === 'HEAD').length, 2);
  assert.deepEqual(identities.identities, { 'a.ts': 'blob-a', 'b.ts': 'blob-b' }, 'file identities can be hydrated after first render');
  assert.equal(requests.filter(request => request.path.includes('/groups/') && request.path.includes('/members/all/')).length, 0, 'bootstrap returns without waiting for per-owner membership checks');
  const ownership = await call('verify-owners', { paths: ['a.ts'], targetBranch: 'main' });
  assert.equal(ownership.ownerWarning, undefined, 'a wildcard fallback and exclusions in a real GitLab CODEOWNERS file do not disable ownership parsing');
  assert.ok(ownership.codeowners.some(rule => rule.exclude && rule.pattern === 'docs/private/**'));
  const ownerStatus = ownership.ownerStatus;
  assert.equal(ownerStatus['@reviewer'], true);
  assert.equal(ownerStatus['another@example.com'], false, 'another email owner is not an unverifiable match');
  assert.equal(ownerStatus['@nested/team'], true, 'inherited group membership is checked by user ID');
  assert.equal(ownerStatus['@nested/team%developer'], true, 'the cached numeric access level satisfies the developer threshold');
  assert.equal(ownerStatus['@nested/team%maintainer'], false, 'the same cached numeric access level fails a maintainer threshold');
  assert.equal(ownerStatus['@missing-group'], null, 'a 404 cannot distinguish nonmembership from inaccessible group data');
  const membershipRequests = () => requests.filter(request => request.path.includes('/groups/') && request.path.includes('/members/all/'));
  assert.ok(Number.isFinite(Date.parse(ownership.membershipCheckedAt)), 'confirmed memberships report when they were last checked');
  assert.equal(membershipRequests().length, 2);
  assert.ok(requests.some(request => request.path.endsWith('/groups/nested%2Fteam/members/all/5')));
  assert.ok(!requests.some(request => request.path.includes('/groups/unused%2Fgroup/members/all/5')), 'only owners that apply to changed paths are checked');
  await call('verify-owners', { paths: ['a.ts'], targetBranch: 'main' });
  assert.equal(membershipRequests().filter(request => request.path.endsWith('/groups/nested%2Fteam/members/all/5')).length, 1, 'a confirmed access level is reused from disk');
  assert.equal(membershipRequests().filter(request => request.path.endsWith('/groups/missing-group/members/all/5')).length, 2, 'an ambiguous 404 is not cached');
  nestedAccessLevel = 40;
  const refreshedMemberships = await call('verify-owners', { paths: ['a.ts'], targetBranch: 'main', refreshMemberships: true });
  assert.equal(refreshedMemberships.ownerStatus['@nested/team%maintainer'], true, 'manual refresh updates the stored effective access level after a membership change');
  assert.equal(membershipRequests().filter(request => request.path.endsWith('/groups/nested%2Fteam/members/all/5')).length, 2, 'manual refresh invalidates and rechecks successful membership');
  assert.equal(membershipRequests().filter(request => request.path.endsWith('/groups/missing-group/members/all/5')).length, 3, 'manual refresh retries unresolved membership');
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

test('section default owners apply only to paths listed in that CODEOWNERS section', async t => {
  const originalFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'review-master-sections-'));
  const config = join(directory, 'accounts.json');
  await writeFile(config, JSON.stringify([{ host: 'https://gitlab.example', token: 'section-test-token', username: 'reviewer' }]), { mode: 0o600 });
  process.env.REVIEW_MASTER_CONFIG = config;
  const codeowners = '[Docs] @docs/team\ndocs/**/*.md\n[Infra] @infra/team\ninfra/**\n';
  const diffs = ['docs/guide.md', 'infra/service.yml', 'src/unowned.ts'].map(path => ({
    old_path: path, new_path: path, diff: '', new_file: false, deleted_file: false, renamed_file: false,
  }));
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    requests.push({ path: url.pathname, method });
    if (url.pathname.endsWith('/api/v4/user')) return new Response(JSON.stringify({ id: 5, username: 'reviewer' }), { status: 200 });
    if (url.pathname.endsWith('/api/v4/projects/group%2Fapp/merge_requests/7')) return new Response(JSON.stringify({ id: 77, iid: 7, title: 'Section defaults', target_branch: 'main', sha: 'head', diff_refs: {} }), { status: 200 });
    if (url.pathname.endsWith('/api/v4/projects/group%2Fapp')) return new Response(JSON.stringify({ id: 2, path_with_namespace: 'group/app', namespace: {}, permissions: { project_access: { access_level: 30 } } }), { status: 200 });
    if (url.pathname.endsWith('/merge_requests/7/versions')) return new Response(JSON.stringify([{ id: 1, created_at: '2026-10-01T12:00:00Z', head_commit_sha: 'head', base_commit_sha: 'base', start_commit_sha: 'base', state: 'collected' }]), { status: 200 });
    if (url.pathname.endsWith('/versions/1')) return new Response(JSON.stringify({ id: 1, head_commit_sha: 'head', base_commit_sha: 'base', start_commit_sha: 'base', state: 'collected', diffs }), { status: 200 });
    if (url.pathname.endsWith('/diffs')) return new Response(JSON.stringify(diffs), { status: 200 });
    if (url.pathname.endsWith('/discussions') || url.pathname.endsWith('/draft_notes')) return new Response('[]', { status: 200 });
    if (url.pathname.endsWith('/groups/docs%2Fteam/members/all/5') || url.pathname.endsWith('/groups/infra%2Fteam/members/all/5')) return new Response(JSON.stringify({ id: 5, access_level: 30 }), { status: 200 });
    if (url.pathname.includes('/repository/files/')) {
      if (url.pathname.endsWith('/CODEOWNERS/raw')) return new Response(codeowners, { status: 200 });
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'x-gitlab-blob-id': 'blob-id' } });
    }
    return new Response('{}', { status: 404 });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.REVIEW_MASTER_CONFIG;
    await rm(directory, { recursive: true, force: true });
  });

  await handler({
    headers: { host: '127.0.0.1:4173' },
    body: { mrUrl: 'https://gitlab.example/group/app/-/merge_requests/7', action: 'bootstrap' },
  });

  const ownerStatus = await handler({
    headers: { host: '127.0.0.1:4173' },
    body: { mrUrl: 'https://gitlab.example/group/app/-/merge_requests/7', action: 'verify-owners', payload: { paths: ['docs/guide.md', 'infra/service.yml', 'src/unowned.ts'], targetBranch: 'main' } },
  });
  assert.deepEqual(ownerStatus.ownerStatus, { '@docs/team': true, '@infra/team': true });
  assert.equal(ownerStatus.codeowners.length, 2);
  assert.equal(requests.filter(request => request.path.includes('/groups/') && request.path.includes('/members/all/')).length, 2);
  assert.ok(!requests.some(request => request.path.endsWith('/groups/src%2Funowned/members/all/5')));
});

test('41 group memberships persist across merge requests and a new CLI process; only new groups require a request', { timeout: 30_000 }, async t => {
  const originalFetch = globalThis.fetch;
  const originalConfig = process.env.REVIEW_MASTER_CONFIG;
  const directory = await mkdtemp(join(tmpdir(), 'review-master-41-groups-'));
  const config = join(directory, 'accounts.json');
  await writeFile(config, JSON.stringify([{ host: 'https://gitlab.example', token: 'persistent-test-token', username: 'reviewer' }]), { mode: 0o600 });
  process.env.REVIEW_MASTER_CONFIG = config;
  const groups = Array.from({ length: 41 }, (_, index) => `owners/team-${index}`);
  const paths = groups.map((_, index) => `src/file-${index}.ts`);
  let codeowners = groups.map((group, index) => `${paths[index]} @${group}`).join('\n');
  const membershipCalls = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/v4/user')) return new Response(JSON.stringify({ id: 507, username: 'reviewer' }), { status: 200 });
    if (url.pathname.endsWith('/api/v4/projects/group%2Fapp') || url.pathname.endsWith('/api/v4/projects/other%2Fapp')) return new Response(JSON.stringify({ id: 2, permissions: { project_access: { access_level: 30 } } }), { status: 200 });
    if (url.pathname.endsWith('/CODEOWNERS/raw')) return new Response(codeowners, { status: 200 });
    if (url.pathname.includes('/groups/') && url.pathname.includes('/members/all/')) {
      membershipCalls.push(url.pathname);
      return new Response(JSON.stringify({ id: 507, access_level: 30 }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    originalConfig === undefined ? delete process.env.REVIEW_MASTER_CONFIG : process.env.REVIEW_MASTER_CONFIG = originalConfig;
    await rm(directory, { recursive: true, force: true });
  });

  const call = (route, projectPath, ownerPaths) => route({
    headers: { host: '127.0.0.1:4173' },
    body: { mrUrl: `https://gitlab.example/${projectPath}/-/merge_requests/8`, action: 'verify-owners', payload: { paths: ownerPaths, targetBranch: 'main' } },
  });
  const coldStarted = Date.now();
  const cold = await call(handler, 'group/app', paths);
  const coldElapsed = Date.now() - coldStarted;
  assert.equal(Object.values(cold.ownerStatus).filter(Boolean).length, 41);
  assert.equal(membershipCalls.length, 41, 'first run verifies each distinct owner group once');

  const warmStarted = Date.now();
  const warm = await call(handler, 'other/app', paths);
  const warmElapsed = Date.now() - warmStarted;
  assert.equal(Object.values(warm.ownerStatus).filter(Boolean).length, 41);
  assert.equal(membershipCalls.length, 41, 'another MR/project reuses all known effective access levels');

  const childRoute = `
    globalThis.createError = options => Object.assign(new Error(options.statusMessage), options);
    globalThis.defineEventHandler = handler => handler;
    globalThis.readBody = event => event.body;
    globalThis.getRequestHeader = (event, name) => event.headers?.[name];
    let membershipRequests = 0;
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/api/v4/user')) return new Response(JSON.stringify({ id: 507, username: 'reviewer' }), { status: 200 });
      if (url.pathname.endsWith('/api/v4/projects/group%2Fapp')) return new Response(JSON.stringify({ id: 2, permissions: { project_access: { access_level: 30 } } }), { status: 200 });
      if (url.pathname.endsWith('/CODEOWNERS/raw')) return new Response(${JSON.stringify(codeowners)}, { status: 200 });
      if (url.pathname.includes('/groups/') && url.pathname.includes('/members/all/')) membershipRequests++;
      return new Response('{}', { status: 404 });
    };
    const { default: route } = await import(${JSON.stringify(new URL('../server/api/gitlab.post.ts', import.meta.url).href)});
    const result = await route({ headers: { host: '127.0.0.1:4173' }, body: { mrUrl: 'https://gitlab.example/group/app/-/merge_requests/9', action: 'verify-owners', payload: { paths: ${JSON.stringify(paths)}, targetBranch: 'main' } } });
    console.log(JSON.stringify({ ownerStatus: result.ownerStatus, membershipRequests }));
  `;
  const restarted = spawnSync(process.execPath, ['--input-type=module', '--eval', childRoute], {
    encoding: 'utf8',
    env: { ...process.env, REVIEW_MASTER_CONFIG: config, PATH: '' },
  });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.ok(restarted.stdout.trim(), JSON.stringify({ status: restarted.status, error: restarted.error?.message, signal: restarted.signal, stderr: restarted.stderr }));
  const restartedResult = JSON.parse(restarted.stdout.trim());
  assert.equal(Object.values(restartedResult.ownerStatus).filter(Boolean).length, 41);
  assert.equal(restartedResult.membershipRequests, 0, 'a fresh Node process reuses the durable snapshot without membership API calls');

  codeowners += '\nsrc/new.ts @owners/new-team';
  const updated = await call(handler, 'group/app', ['src/new.ts']);
  assert.deepEqual(updated.ownerStatus, { '@owners/new-team': true });
  assert.equal(membershipCalls.length, 42, 'a new owner path causes only its new membership lookup');
  assert.ok(Number.isFinite(coldElapsed) && Number.isFinite(warmElapsed), 'cold and warm route durations are measured');
  console.log(`RMR-7 41-owner route timings: cold ${coldElapsed}ms; warm ${warmElapsed}ms; membership requests ${41} then ${0}`);
});

test('forbidden, rate-limited and server-error memberships stay unknown and are retried', async t => {
  const originalFetch = globalThis.fetch;
  const originalConfig = process.env.REVIEW_MASTER_CONFIG;
  const directory = await mkdtemp(join(tmpdir(), 'review-master-owner-errors-'));
  const config = join(directory, 'accounts.json');
  await writeFile(config, JSON.stringify([{ host: 'https://gitlab.example', token: 'error-test-token', username: 'reviewer' }]), { mode: 0o600 });
  process.env.REVIEW_MASTER_CONFIG = config;
  const codeowners = 'src/a.ts @groups/forbidden\nsrc/b.ts @groups/rate\nsrc/c.ts @groups/server';
  const requests = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/api/v4/user')) return new Response(JSON.stringify({ id: 75, username: 'reviewer' }), { status: 200 });
    if (url.pathname.endsWith('/api/v4/projects/group%2Fapp')) return new Response(JSON.stringify({ id: 2 }), { status: 200 });
    if (url.pathname.endsWith('/CODEOWNERS/raw')) return new Response(codeowners, { status: 200 });
    if (url.pathname.includes('/groups/') && url.pathname.includes('/members/all/')) {
      requests.push(url.pathname);
      if (url.pathname.includes('forbidden')) return new Response('', { status: 403 });
      if (url.pathname.includes('rate')) return new Response('', { status: 429 });
      return new Response('', { status: 503 });
    }
    return new Response('{}', { status: 404 });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    originalConfig === undefined ? delete process.env.REVIEW_MASTER_CONFIG : process.env.REVIEW_MASTER_CONFIG = originalConfig;
    await rm(directory, { recursive: true, force: true });
  });

  const call = () => handler({
    headers: { host: '127.0.0.1:4173' },
    body: { mrUrl: 'https://gitlab.example/group/app/-/merge_requests/10', action: 'verify-owners', payload: { paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'], targetBranch: 'main' } },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await call();
    assert.deepEqual(result.ownerStatus, { '@groups/forbidden': null, '@groups/rate': null, '@groups/server': null });
  }
  assert.equal(requests.length, 6, 'failed membership requests are not persisted as negative results');
});
