import test from 'node:test';
import assert from 'node:assert/strict';
import { codeownersForPath, globMatches } from '../shared/codeowners.ts';

test('relative CODEOWNERS globstars match below repository root', () => {
  assert.equal(globMatches('releases/**/*.md', 'doc/releases/19/release.md'), true);
  assert.equal(globMatches('/releases/**/*.md', 'doc/releases/19/release.md'), false);
});

test('CODEOWNERS exclusions apply in order within their own section', () => {
  const rules = [
    { pattern: '**', owners: ['@maintainers'], section: 'Maintainers' },
    { pattern: 'doc/releases/**', owners: ['@docs'], section: 'Docs' },
    { pattern: 'doc/releases/private/**', owners: [], section: 'Docs', exclude: true },
    { pattern: 'doc/releases/private/restore.md', owners: ['@later'], section: 'Docs' },
  ];

  assert.deepEqual(codeownersForPath(rules, 'doc/releases/19/release.md'), {
    matched: true,
    owners: ['@maintainers', '@docs'],
  });
  assert.deepEqual(codeownersForPath(rules, 'doc/releases/private/restore.md'), {
    matched: true,
    owners: ['@maintainers'],
  });
});
