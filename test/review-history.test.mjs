import test from 'node:test';
import assert from 'node:assert/strict';

const { latestVersionId, pathForSelectedVersion, reconcileVersions, versionReviewStatus } = await import('../app/utils/review-history.ts');
const versions = ids => ids.map(id => ({ id }));
const file = (path, identity = null, deleted_file = false) => ({ old_path: path, new_path: path, identity, deleted_file });

test('initial history selection uses the latest push', () => {
  assert.equal(latestVersionId(versions([3, 2, 1])), 3);
  assert.equal(latestVersionId([]), null);
});

test('refresh reports new pushes without changing the selected version', () => {
  const refreshed = reconcileVersions(versions([2, 1]), versions([3, 2, 1]), 2);
  assert.deepEqual(refreshed.addedVersionIds, [3]);
  assert.equal(refreshed.selectedVersionId, 2);
  assert.equal(refreshed.selectedStillAvailable, true);
});

test('version navigation retains the open file when possible and picks a visible fallback otherwise', () => {
  const nextFiles = [file('src/other.ts'), file('src/app.ts')];
  assert.equal(pathForSelectedVersion('src/app.ts', nextFiles), 'src/app.ts');
  assert.equal(pathForSelectedVersion('src/removed.ts', nextFiles), 'src/other.ts');
  assert.equal(pathForSelectedVersion('src/removed.ts', []), '');
  assert.equal(pathForSelectedVersion('src/deleted.ts', [file('src/deleted.ts', null, true)]), 'src/deleted.ts');
});

test('review progress stays with each version and changed file content starts unreviewed', () => {
  const oldFile = file('src/app.ts', 'blob-v2');
  const newFile = file('src/app.ts', 'blob-v3');
  const byVersion = { '2': { 'src/app.ts': 'blob-v2' } };
  const complete = { '2': true };
  assert.equal(versionReviewStatus(2, 2, [oldFile], byVersion['2'], byVersion, complete), 'reviewed');
  assert.equal(versionReviewStatus(2, 3, [newFile], {}, byVersion, complete), 'reviewed', 'a completed older delta remains complete after navigation');
  assert.equal(versionReviewStatus(3, 3, [newFile], {}, byVersion, complete), 'not-reviewed');
  assert.equal(versionReviewStatus(3, 3, [oldFile, newFile], { 'src/app.ts': 'blob-v2' }, byVersion, complete), 'in-progress');
  assert.equal(versionReviewStatus(3, 3, [], {}, byVersion, complete), 'no-changes');
});
