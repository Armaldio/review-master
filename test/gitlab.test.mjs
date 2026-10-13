import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.createError = options => Object.assign(new Error(options.statusMessage), options);
const { parseMergeRequestUrl, validatePreviewUrl, discoverPreviews, gitlab, resolveGitLabToken } = await import('../server/utils/gitlab.ts');

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
  let authHeader;
  globalThis.fetch = async (_url, init) => { redirectMode = init.redirect; authHeader = init.headers.Authorization; return new Response('secret echoed by upstream', { status: 302, headers: { location: 'https://attacker.example' } }); };
  await assert.rejects(() => gitlab('https://gitlab.example/api/v4/user', 'token-value'), error => {
    assert.equal(error.statusCode, 502);
    assert.doesNotMatch(error.message, /token-value|secret echoed/);
    return true;
  });
  assert.equal(redirectMode, 'manual');
  assert.equal(authHeader, 'Bearer token-value');
  globalThis.fetch = async () => new Response('do not expose', { status: 429, headers: { 'retry-after': '30' } });
  await assert.rejects(() => gitlab('https://gitlab.example/api/v4/user', 'token-value'), error => {
    assert.equal(error.statusCode, 429);
    assert.equal(error.data.retryAfter, '30');
    assert.doesNotMatch(error.message, /do not expose/);
    return true;
  });
});

test('explains stale GitLab diff positions so reviewers can refresh and reselect a line', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'position is outdated' }), { status: 400 });
  await assert.rejects(() => gitlab('https://gitlab.example/api/v4/notes', 'token-value'), error => {
    assert.equal(error.statusCode, 400);
    assert.match(error.statusMessage, /position is out of date/i);
    assert.match(error.statusMessage, /refresh.*reselect/i);
    assert.doesNotMatch(error.message, /token-value|position is outdated/);
    return true;
  });
});

test('resolves GitLab.com and self-managed credentials independently by exact host', async () => {
  const candidates = new Map([
    ['gitlab.com', 'gitlab-com-token'],
    ['gitlab.example:8443', 'self-managed-token'],
  ]);
  const verified = [];
  const tokenFor = async (host, expectedToken) => resolveGitLabToken(host, undefined,
    async hostname => candidates.get(hostname) || '',
    async (candidateHost, token) => {
      verified.push([candidateHost, token]);
      return token === candidates.get(new URL(candidateHost).host) && token === expectedToken;
    });

  assert.equal(await tokenFor('https://gitlab.com', 'gitlab-com-token'), 'gitlab-com-token');
  assert.equal(await tokenFor('https://gitlab.example:8443', 'self-managed-token'), 'self-managed-token');
  assert.deepEqual(verified, [
    ['https://gitlab.com', 'gitlab-com-token'],
    ['https://gitlab.example:8443', 'self-managed-token'],
  ]);
});

test('accepts an environment-backed glab token candidate after exact-host verification', async () => {
  let requestedHost;
  const token = await resolveGitLabToken('https://gitlab.com', undefined, async hostname => {
    requestedHost = hostname;
    return 'environment-token';
  }, async (host, candidate) => host === 'https://gitlab.com' && candidate === 'environment-token');
  assert.equal(requestedHost, 'gitlab.com');
  assert.equal(token, 'environment-token');
});

test('does not pass environment tokens for the configured host to another MR host', async t => {
  const keys = ['GITLAB_HOST', 'GITLAB_URI', 'GL_HOST', 'GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => keys.forEach(key => previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]));
  for (const key of keys) delete process.env[key];
  process.env.GITLAB_TOKEN = 'gitlab-com-only-token';

  let gitlabComEnvironment;
  const gitlabComToken = await resolveGitLabToken('https://gitlab.com', undefined, async (_host, env) => {
    gitlabComEnvironment = env;
    return env?.GITLAB_TOKEN || '';
  }, async (host, token) => host === 'https://gitlab.com' && token === 'gitlab-com-only-token');
  assert.equal(gitlabComToken, 'gitlab-com-only-token');
  assert.equal(gitlabComEnvironment?.GITLAB_TOKEN, 'gitlab-com-only-token');

  let selfManagedEnvironment;
  const selfManagedToken = await resolveGitLabToken('https://gitlab.example', undefined, async (_host, env) => {
    selfManagedEnvironment = env;
    return env?.GITLAB_TOKEN || 'self-managed-keyring-token';
  }, async (host, token) => host === 'https://gitlab.example' && token === 'self-managed-keyring-token');
  assert.equal(selfManagedToken, 'self-managed-keyring-token');
  assert.equal(selfManagedEnvironment?.GITLAB_TOKEN, undefined);
});

test('accepts a keyring/config-backed glab token candidate after exact-host verification', async () => {
  let requestedHost;
  const token = await resolveGitLabToken('https://gitlab.example', undefined, async hostname => {
    requestedHost = hostname;
    return 'keyring-config-token';
  }, async (host, candidate) => host === 'https://gitlab.example' && candidate === 'keyring-config-token');
  assert.equal(requestedHost, 'gitlab.example');
  assert.equal(token, 'keyring-config-token');
});

test('verifies glab credentials using the same Bearer authentication accepted for PAT and OAuth tokens', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), headers: init.headers, redirect: init.redirect };
    return new Response('{}', { status: 200 });
  };
  const token = await resolveGitLabToken('https://gitlab.example', undefined, async () => 'glab-token');
  assert.equal(token, 'glab-token');
  assert.deepEqual(request, {
    url: 'https://gitlab.example/api/v4/user',
    headers: { Authorization: 'Bearer glab-token' },
    redirect: 'manual',
  });
});

test('uses a verified legacy account token when glab has no usable token', async () => {
  const token = await resolveGitLabToken('https://gitlab.example', 'legacy-token', async () => {
    throw new Error('glab is missing');
  }, async (_host, value) => value === 'legacy-token');
  assert.equal(token, 'legacy-token');
});

test('falls back to a verified legacy token when the glab credential is expired or invalid', async () => {
  const checked = [];
  const token = await resolveGitLabToken('https://gitlab.example', 'legacy-valid-token', async () => 'expired-glab-token', async (_host, candidate) => {
    checked.push(candidate);
    return candidate === 'legacy-valid-token';
  });
  assert.equal(token, 'legacy-valid-token');
  assert.deepEqual(checked, ['expired-glab-token', 'legacy-valid-token']);
});

test('reports an actionable error when glab is missing and no legacy token is available', async () => {
  await assert.rejects(
    () => resolveGitLabToken('https://gitlab.example', undefined, async () => { throw new Error('spawn glab ENOENT'); }, async () => false),
    error => {
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /glab auth login --hostname gitlab\.example/);
      assert.doesNotMatch(error.message, /ENOENT|spawn/);
      return true;
    },
  );
});

test('rejects unverified credentials with an actionable error and no token disclosure', async () => {
  await assert.rejects(
    () => resolveGitLabToken('https://gitlab.example', 'legacy-secret', async () => 'glab-secret', async () => false),
    error => {
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /glab auth login --hostname gitlab\.example/);
      assert.doesNotMatch(error.message, /legacy-secret|glab-secret/);
      return true;
    },
  );
});
