import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const importCache = () => import(`../server/utils/membership-cache.ts?instance=${Math.random()}`);

async function withCache(t, run) {
  const previousConfig = process.env.REVIEW_MASTER_CONFIG;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const directory = await mkdtemp(join(tmpdir(), 'mergepeek-membership-'));
  process.env.REVIEW_MASTER_CONFIG = join(directory, 'review-master', 'accounts.json');
  delete process.env.XDG_CONFIG_HOME;
  t.after(async () => {
    previousConfig === undefined ? delete process.env.REVIEW_MASTER_CONFIG : process.env.REVIEW_MASTER_CONFIG = previousConfig;
    previousXdg === undefined ? delete process.env.XDG_CONFIG_HOME : process.env.XDG_CONFIG_HOME = previousXdg;
    await rm(directory, { recursive: true, force: true });
  });
  await run(directory);
}

test('membership snapshots survive a fresh module instance and thresholds are evaluated by callers', async t => {
  await withCache(t, async () => {
    const first = await importCache();
    await first.writeMembership('https://gitlab.example', 17, '@platform/team', 30);
    const restartedModule = await importCache();
    const snapshot = await restartedModule.readMembership('https://gitlab.example/', 17, 'platform/team/');
    assert.equal(snapshot?.accessLevel, 30);
    assert.ok(snapshot?.checkedAt);
    assert.equal(snapshot.accessLevel >= 20, true);
    assert.equal(snapshot.accessLevel >= 40, false, 'cache stores effective access, not a threshold-specific result');
  });
});

test('entries are isolated by origin, immutable user ID, and normalized full group path', async t => {
  await withCache(t, async () => {
    const cache = await importCache();
    await cache.writeMembership('https://gitlab.example', 17, 'Platform/Team', 40);
    assert.equal((await cache.readMembership('https://gitlab.example', 17, 'platform/team'))?.accessLevel, 40);
    assert.equal(await cache.readMembership('https://other.example', 17, 'platform/team'), null);
    assert.equal(await cache.readMembership('https://gitlab.example', 18, 'platform/team'), null);
    assert.equal(await cache.readMembership('https://gitlab.example', 17, 'platform/other'), null);
    await cache.deleteMembership('https://gitlab.example', 17, '@PLATFORM/TEAM');
    assert.equal(await cache.readMembership('https://gitlab.example', 17, 'platform/team'), null);
  });
});

test('corrupt or unreadable cache files are treated as misses and can be replaced', async t => {
  await withCache(t, async directory => {
    const cache = await importCache();
    const cachePath = join(directory, 'review-master', 'owner-membership.json');
    await mkdir(join(directory, 'review-master'), { recursive: true });
    await writeFile(cachePath, '{invalid json');
    assert.equal(await cache.readMembership('https://gitlab.example', 17, 'platform/team'), null);
    await cache.writeMembership('https://gitlab.example', 17, 'platform/team', 30);
    assert.equal((await cache.readMembership('https://gitlab.example', 17, 'platform/team'))?.accessLevel, 30);
    await writeFile(cachePath, JSON.stringify({ version: 1, entries: [{ host: 'https://gitlab.example', userId: 17, groupPath: 'x', accessLevel: 40, checkedAt: 'invalid' }] }));
    assert.equal(await cache.readMembership('https://gitlab.example', 17, 'x'), null);
  });
});

test('writes replace atomically, restrict file permissions, and serialize concurrent updates', async t => {
  await withCache(t, async directory => {
    const cache = await importCache();
    await Promise.all([
      cache.writeMembership('https://gitlab.example', 17, 'one/team', 30),
      cache.writeMembership('https://gitlab.example', 17, 'two/team', 40),
      cache.writeMembership('https://gitlab.example', 18, 'one/team', 50),
    ]);
    const cachePath = join(directory, 'review-master', 'owner-membership.json');
    const contents = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(contents);
    assert.equal(parsed.entries.length, 3);
    assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(join(directory, 'review-master'))).filter(name => name.endsWith('.tmp')), []);
    assert.equal((await cache.readMembership('https://gitlab.example', 17, 'one/team'))?.accessLevel, 30);
  });
});

test('invalid and non-positive membership data is never persisted', async t => {
  await withCache(t, async directory => {
    const cache = await importCache();
    await cache.writeMembership('https://gitlab.example', 0, 'team', 30);
    await cache.writeMembership('https://gitlab.example', 17, 'team', 0);
    assert.equal(await cache.readMembership('https://gitlab.example', 17, 'team'), null);
    await assert.rejects(readFile(join(directory, 'review-master', 'owner-membership.json')));
  });
});
