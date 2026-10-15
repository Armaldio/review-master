import test from 'node:test';
import assert from 'node:assert/strict';
import { commentableLinesForDelta } from '../server/utils/diff-comment-positions.ts';

const diff = (content, path = 'src/app.ts') => ({ old_path: path, new_path: path, diff: content });

test('only exposes incremental changed lines present in the official MR version diff', () => {
  const delta = [diff('@@ -8 +8 @@\n-old line\n+new line\n')];
  const officialVersion = [diff('@@ -8 +8 @@\n-old line\n+new line\n')];

  assert.deepEqual(commentableLinesForDelta(delta, officialVersion), [
    { old_path: 'src/app.ts', new_path: 'src/app.ts', old_lines: [8], new_lines: [8] },
  ]);
});

test('does not expose a delta line absent from the official MR version diff', () => {
  const delta = [diff('@@ -28 +28 @@\n-old line\n+new line\n')];
  const officialVersion = [diff('@@ -8 +8 @@\n-old line\n+new line\n')];

  assert.deepEqual(commentableLinesForDelta(delta, officialVersion), [
    { old_path: 'src/app.ts', new_path: 'src/app.ts', old_lines: [], new_lines: [] },
  ]);
});

test('keeps renamed paths distinct and ignores incomplete official file diffs', () => {
  const delta = [{ old_path: 'src/old.ts', new_path: 'src/new.ts', diff: '@@ -4 +4 @@\n-old\n+new\n' }];
  const officialVersion = [
    { old_path: 'src/other.ts', new_path: 'src/new.ts', diff: '@@ -4 +4 @@\n-old\n+new\n' },
    { old_path: 'src/old.ts', new_path: 'src/new.ts', diff: '@@ -4 +4 @@\n-old\n+new\n', collapsed: true },
  ];

  assert.deepEqual(commentableLinesForDelta(delta, officialVersion), [
    { old_path: 'src/old.ts', new_path: 'src/new.ts', old_lines: [], new_lines: [] },
  ]);
});
