import test from 'node:test';
import assert from 'node:assert/strict';
import { codeownersForPath, globMatches, parseCodeowners } from '../shared/codeowners.ts';

test('relative CODEOWNERS globstars match below repository root', () => {
  assert.equal(globMatches('releases/**/*.md', 'doc/releases/19/release.md'), true);
  assert.equal(globMatches('/releases/**/*.md', 'doc/releases/19/release.md'), false);
});

test('the last matching entry wins within each CODEOWNERS section', () => {
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
    owners: ['@maintainers', '@later'],
  });
  assert.deepEqual(codeownersForPath(rules, 'doc/releases/private/other.md'), {
    matched: true,
    owners: ['@maintainers'],
  });
});

test('section default owners stay scoped to matching patterns in their section', () => {
  const { rules, warning } = parseCodeowners([
    '[Docs] @docs/team',
    'docs/**/*.md',
    '[Infra] @infra/team',
    'infra/**',
    '[Unowned]',
    'src/**',
  ].join('\n'));

  assert.equal(warning, undefined);
  assert.deepEqual(codeownersForPath(rules, 'docs/guide.md'), { matched: true, owners: ['@docs/team'] });
  assert.deepEqual(codeownersForPath(rules, 'infra/service.yml'), { matched: true, owners: ['@infra/team'] });
  assert.deepEqual(codeownersForPath(rules, 'src/app.ts'), { matched: true, owners: [] });
  assert.deepEqual(codeownersForPath(rules, 'src/other.md'), { matched: true, owners: [] });
  assert.deepEqual(codeownersForPath(rules, 'tests/readme.md'), { matched: false, owners: [] });
});

test('later matching rules override within a section while matching sections accumulate', () => {
  const { rules } = parseCodeowners([
    '[All] @all/team',
    '**',
    '[Docs] @docs/team',
    'docs/**',
    'docs/private/** @security/team',
    '!docs/private/generated/**',
    '[KeepDocs] @docs/team',
    'docs/private/generated/keep.md',
  ].join('\n'));

  assert.deepEqual(codeownersForPath(rules, 'docs/guide.md'), { matched: true, owners: ['@all/team', '@docs/team'] });
  assert.deepEqual(codeownersForPath(rules, 'docs/private/secret.md'), { matched: true, owners: ['@all/team', '@security/team'] });
  assert.deepEqual(codeownersForPath(rules, 'docs/private/generated/tmp.md'), { matched: true, owners: ['@all/team'] });
  assert.deepEqual(codeownersForPath(rules, 'docs/private/generated/keep.md'), { matched: true, owners: ['@all/team', '@docs/team'] });
});
