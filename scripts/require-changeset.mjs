#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const [base, head] = process.argv.slice(2);
if (!base || !head) throw new Error('Usage: node scripts/require-changeset.mjs <base-sha> <head-sha>');

const changed = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const releaseFiles = changed.filter(path => path.startsWith('.changeset/') && path.endsWith('.md') && path !== '.changeset/README.md');

if (releaseFiles.length === 0) {
  console.error('Every PR needs a Changesets file. Run `npm run changeset` for a package release or `npm run changeset -- --empty` when no release is needed.');
  process.exit(1);
}

console.log(`Found ${releaseFiles.length} Changesets file(s).`);
