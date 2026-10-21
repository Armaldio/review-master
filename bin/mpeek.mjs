#!/usr/bin/env node
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import open from 'open';

// Keep the original directory so existing accounts remain available after the rename.
const dataDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'review-master');
const accountsFile = join(dataDir, 'accounts.json');
const args = process.argv.slice(2);
const usage = () => console.log(`mpeek <gitlab-mr-url>\nmpeek account add <https://gitlab.example.com>\nmpeek account list\nmpeek account remove <host>\nLocal server binds to 127.0.0.1:4173 by default; override with REVIEW_MASTER_HOST and REVIEW_MASTER_PORT.`);
const readSecret = () => new Promise((resolve, reject) => {
  if (!process.stdin.isTTY) return reject(new Error('Account setup requires an interactive terminal'));
  process.stdout.write('Personal access token: ');
  let secret = '';
  const finish = error => {
    process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener('data', onData); process.stdout.write('\n');
    error ? reject(error) : resolve(secret);
  };
  const onData = data => {
    for (const char of data.toString('utf8')) {
      if (char === '\u0003') return finish(new Error('Cancelled'));
      if (char === '\r' || char === '\n') return finish();
      if (char === '\u007f' || char === '\b') secret = secret.slice(0, -1);
      else secret += char;
    }
  };
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8'); process.stdin.on('data', onData);
});
const normalizedHost = value => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Host must be an absolute HTTP(S) origin without credentials or a path');
  return url.origin;
};
const load = async () => {
  let contents;
  try { contents = await readFile(accountsFile, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  try { return JSON.parse(contents); } catch { throw new Error(`Saved GitLab accounts file is invalid JSON: ${accountsFile}`); }
};
const save = async value => {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${accountsFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, accountsFile);
};

try {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { usage(); process.exit(0); }
  if (args[0] === 'account') {
    const accounts = await load();
    if (args[1] === 'add' && args.length === 3) {
      const host = normalizedHost(args[2]);
      const token = await readSecret();
      if (!token) throw new Error('Token cannot be empty');
      const user = await fetch(`${host}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': token }, redirect: 'manual' });
      if (!user.ok) throw new Error(`GitLab rejected the token (${user.status})`);
      const profile = await user.json();
      const next = accounts.filter(a => a.host !== host);
      next.push({ host, token, username: profile.username, name: profile.name });
      await save(next);
      console.log(`Added ${profile.username} at ${host}`);
      process.exit(0);
    }
    if (args[1] === 'list' && args.length === 2) { accounts.forEach(a => console.log(`${a.username}  ${a.host}`)); process.exit(0); }
    if (args[1] === 'remove' && args.length === 3) { const host = normalizedHost(args[2]); await save(accounts.filter(a => a.host !== host)); process.exit(0); }
    usage(); process.exit(args.length ? 2 : 0);
  }
  if (args.length !== 1) { usage(); process.exit(args.length ? 2 : 0); }
  const mr = new URL(args[0]);
  if (!['https:', 'http:'].includes(mr.protocol) || mr.username || mr.password) throw new Error('Enter an absolute GitLab merge request URL');
  if (!/\/-\/merge_requests\/\d+\/?$/.test(mr.pathname)) throw new Error('URL must end in /-/merge_requests/<iid>');
  const serverFile = new URL('../.output/server/index.mjs', import.meta.url);
  try { await readFile(serverFile); } catch { throw new Error('Production app is not built. Run npm run build first.'); }
  const server = createServer();
  const host = process.env.REVIEW_MASTER_HOST || '127.0.0.1';
  const port = Number(process.env.REVIEW_MASTER_PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('REVIEW_MASTER_PORT must be an integer between 1 and 65535');
  await new Promise((resolve, reject) => server.once('error', error => reject(error.code === 'EADDRINUSE'
    ? new Error(`Local review port ${port} is already in use. Stop the other MergePeek instance or set REVIEW_MASTER_PORT.`)
    : error)).listen(port, host, resolve));
  await new Promise(resolve => server.close(resolve));
  process.env.NITRO_HOST = host;
  process.env.NITRO_PORT = String(port);
  process.env.REVIEW_MASTER_URL = mr.toString();
  process.env.REVIEW_MASTER_CONFIG = accountsFile;
  process.env.REVIEW_MASTER_CLI = '1';
  const shutdown = () => { process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  console.log(`MergePeek reviewing ${mr.toString()} at http://${host}:${port}`);
  await import(serverFile.href);
  const url = `http://${host}:${port}/?mr=${encodeURIComponent(mr.toString())}`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { const response = await fetch(url); if (response.ok) { ready = true; break; } } catch { /* listener is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Local review server did not start');
  await open(url);
} catch (error) { console.error(`mpeek: ${error.message}`); process.exitCode = 1; }
