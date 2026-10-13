import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const policy = fileURLToPath(new URL('../scripts/require-changeset.mjs', import.meta.url));

test('requires a changeset for every pull request and accepts an empty release note', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'mergepeek-changeset-policy-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  await mkdir(join(repo, 'app'));
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: '@armaldio/mergepeek', version: '3.0.1', devDependencies: {} }));
  await writeFile(join(repo, 'app/page.vue'), '<template>base</template>');
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  await writeFile(join(repo, 'app/page.vue'), '<template>changed</template>');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'code change');
  let head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  let result = spawnSync(process.execPath, [policy, base, head], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Every PR needs a Changesets file/);

  await mkdir(join(repo, '.changeset'));
  await writeFile(join(repo, '.changeset', 'quiet-pandas-smile.md'), '---\n---\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'add changeset');
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  result = spawnSync(process.execPath, [policy, base, head], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
