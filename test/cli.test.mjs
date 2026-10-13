import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/mpeek.mjs', import.meta.url));

test('CLI with no arguments prints usage and exits successfully', () => {
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /mpeek <gitlab-mr-url>/);
  assert.doesNotMatch(result.stdout, /token/i);
});

test('CLI --help prints usage and exits successfully', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /mpeek <gitlab-mr-url>/);
  assert.match(result.stdout, /port defaults to 4173; override with REVIEW_MASTER_PORT/);
});

test('published package exposes mpeek and retains the old command as an alias', async () => {
  const { readFile } = await import('node:fs/promises');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.name, '@armaldio/mergepeek');
  assert.equal(packageJson.bin.mpeek, 'bin/mpeek.mjs');
  assert.equal(packageJson.bin['review-master'], packageJson.bin.mpeek);
});

test('CLI validates merge request URL shape before account lookup', () => {
  const result = spawnSync(process.execPath, [cli, 'https://gitlab.example/group/project/-/issues/2'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /URL must end in \/-\/merge_requests/);
});
