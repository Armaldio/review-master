import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.createError = options => Object.assign(new Error(options.statusMessage), options);
const { parseMergeRequestUrl, validatePreviewUrl, discoverPreviews, gitlab } = await import('../server/utils/gitlab.ts');

test('parses nested GitLab group project paths and merge request IID', () => {
  assert.deepEqual(parseMergeRequestUrl('https://gitlab.example.com/platform/team/app/-/merge_requests/42'), {
    host: 'https://gitlab.example.com', projectPath: 'platform/team/app', iid: '42', encodedProject: 'platform%2Fteam%2Fapp',
  });
  assert.equal(parseMergeRequestUrl('https://gitlab.example.com/platform/team/app/-/merge_requests/42?diff=1#note_1').iid, '42');
});

test('rejects credentialed and non merge request URLs', () => {
  assert.throws(() => parseMergeRequestUrl('https://user:secret@gitlab.example/team/app/-/merge_requests/2'));
  assert.throws(() => parseMergeRequestUrl('https://gitlab.example/team/app/-/issues/2'));
  assert.throws(() => parseMergeRequestUrl('javascript:alert(1)'));
});

test('preview URL validation accepts absolute web URLs only and strips no credentials', () => {
  assert.equal(validatePreviewUrl('https://preview.example/app'), 'https://preview.example/app');
  assert.equal(validatePreviewUrl('http://preview.example/'), 'http://preview.example/');
  for (const url of ['//preview.example', 'file:///etc/passwd', 'https://user:pass@preview.example', 'javascript:alert(1)', ''])
    assert.equal(validatePreviewUrl(url), null);
});

test('preview discovery prefers exact SHA and excludes unrelated and stopped deployments', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async url => {
    const value = String(url);
    const payload = value.includes('/deployments?') ? [
      { id: 1, sha: 'head', ref: 'feature', finished_at: '2026-10-01', environment: { id: 10, name: 'review/feature' } },
      { id: 2, sha: 'old', ref: 'feature', finished_at: '2026-10-02', environment: { id: 11, name: 'review/old' } },
      { id: 3, sha: 'head', ref: 'main', environment: { id: 12, name: 'production' } },
      { id: 4, sha: 'head', ref: 'feature', environment: { id: 13, name: 'stopped' } },
    ] : [
      { id: 10, name: 'review/feature', external_url: 'https://review.example/feature', state: 'available' },
      { id: 11, name: 'review/old', external_url: 'https://review.example/old', state: 'available' },
      { id: 12, name: 'production', external_url: 'https://prod.example', state: 'available', tier: 'production' },
      { id: 13, name: 'stopped', external_url: 'https://old.example', state: 'stopped' },
    ];
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await discoverPreviews('https://gitlab.example', 'group/app', 'secret', 'head', 'feature');
  assert.deepEqual(result.map(item => [item.url, item.match]), [
    ['https://review.example/feature', 'exact'], ['https://review.example/old', 'branch'],
  ]);
});

test('preview discovery discards malicious and unrelated production URLs', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('/deployments?')
    ? [{ id: 1, sha: 'head', ref: 'feature', environment: { id: 1, name: 'review/feature' } }]
    : [{ id: 1, name: 'review/feature', external_url: 'javascript:alert(1)', state: 'available' }]), { status: 200 });
  assert.deepEqual(await discoverPreviews('https://gitlab.example', 'group/app', 'secret', 'head', 'feature'), []);
});

test('GitLab API helper withholds credentials from redirects and exposes rate limits without response bodies', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let redirectMode;
  globalThis.fetch = async (_url, init) => { redirectMode = init.redirect; return new Response('secret echoed by upstream', { status: 302, headers: { location: 'https://attacker.example' } }); };
  await assert.rejects(() => gitlab('https://gitlab.example/api/v4/user', 'token-value'), error => {
    assert.equal(error.statusCode, 502);
    assert.doesNotMatch(error.message, /token-value|secret echoed/);
    return true;
  });
  assert.equal(redirectMode, 'manual');
  globalThis.fetch = async () => new Response('do not expose', { status: 429, headers: { 'retry-after': '30' } });
  await assert.rejects(() => gitlab('https://gitlab.example/api/v4/user', 'token-value'), error => {
    assert.equal(error.statusCode, 429);
    assert.equal(error.data.retryAfter, '30');
    assert.doesNotMatch(error.message, /do not expose/);
    return true;
  });
});
