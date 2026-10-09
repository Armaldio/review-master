import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/review-master.mjs', import.meta.url));

test('CLI with no arguments prints usage and exits successfully', () => {
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /review-master <gitlab-mr-url>/);
  assert.doesNotMatch(result.stdout, /token/i);
});

test('CLI validates merge request URL shape before account lookup', () => {
  const result = spawnSync(process.execPath, [cli, 'https://gitlab.example/group/project/-/issues/2'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /URL must end in \/-\/merge_requests/);
});
