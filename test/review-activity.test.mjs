import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewActivityLogger } from '../server/utils/review-activity.ts';

test('logs new commits and published comments once, but ignores initial and unchanged snapshots', () => {
  const logs = [];
  const track = createReviewActivityLogger(message => logs.push(message));
  const initial = [{ notes: [{ id: 1 }, { id: 2, system: true }] }];

  track('gitlab/project/7', { sha: 'first-sha' }, initial);
  track('gitlab/project/7', { sha: 'first-sha' }, initial);
  assert.deepEqual(logs, []);

  track('gitlab/project/7', { sha: '12345678abcdef' }, [{ notes: [{ id: 1 }, { id: 2, system: true }, { id: 3 }] }]);
  assert.deepEqual(logs, ['MergePeek: new commit 12345678', 'MergePeek: 1 new comment']);

  track('gitlab/project/7', { sha: '12345678abcdef' }, [{ notes: [{ id: 1 }, { id: 2, system: true }, { id: 3 }] }]);
  assert.equal(logs.length, 2, 'repeated polls do not repeat event logs');
});

test('tracks merge requests independently and reports plural comment counts without note contents', () => {
  const logs = [];
  const track = createReviewActivityLogger(message => logs.push(message));
  track('gitlab/project/7', { sha: 'one' }, []);
  track('gitlab/project/8', { sha: 'two' }, []);
  track('gitlab/project/7', { sha: 'one' }, [{ notes: [{ id: 4, body: 'private comment' }, { id: 5 }] }]);

  assert.deepEqual(logs, ['MergePeek: 2 new comments']);
  assert.ok(!logs.join('').includes('private comment'));
});

test('logs when an open merge request is merged or closed, only once', () => {
  const logs = [];
  const track = createReviewActivityLogger(message => logs.push(message));
  track('gitlab/project/7', { state: 'opened' }, []);
  track('gitlab/project/7', { state: 'merged' }, []);
  track('gitlab/project/7', { state: 'merged' }, []);

  assert.deepEqual(logs, ['MergePeek: merge request merged']);
});
