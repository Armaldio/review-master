#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const [base, head] = process.argv.slice(2);
if (!base || !head) throw new Error('Usage: node scripts/require-changeset.mjs <base-sha> <head-sha>');

const changed = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const releaseFiles = changed.filter(path => path.startsWith('.changeset/') && path.endsWith('.md') && path !== '.changeset/README.md');
let packageMetadataChanged = false;
if (changed.includes('package.json')) {
  const before = JSON.parse(execFileSync('git', ['show', `${base}:package.json`], { encoding: 'utf8' }));
  const after = JSON.parse(execFileSync('git', ['show', `${head}:package.json`], { encoding: 'utf8' }));
  packageMetadataChanged = ['name', 'dependencies', 'bin', 'files', 'engines']
    .some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
const packageFiles = packageMetadataChanged || changed.some(path =>
  /^(app|server|bin|public)\//.test(path)
  || path === 'nuxt.config.ts');

if (packageFiles && releaseFiles.length === 0) {
  console.error('This PR changes shipped package code but has no Changesets release note. Run `npm run changeset` and commit the generated file.');
  process.exit(1);
}

console.log(packageFiles ? `Found ${releaseFiles.length} Changesets release note(s).` : 'No shipped package changes require a Changesets release note.');
