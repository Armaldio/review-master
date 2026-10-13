#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const archive = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node scripts/verify-package.mjs <package.tgz>');

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (source.name !== '@armaldio/mergepeek' || !source.bin?.mpeek) {
  throw new Error('Expected the @armaldio/mergepeek package with the mpeek command');
}

const installDir = await mkdtemp(join(tmpdir(), 'mergepeek-package-'));
try {
  const install = spawnSync('npm', [
    'install', '--prefix', installDir, '--ignore-scripts', '--no-audit', '--no-fund', archive,
  ], { cwd: root, encoding: 'utf8' });
  if (install.status !== 0) {
    throw new Error(`Could not install packed artifact:\n${install.stdout}${install.stderr}`);
  }

  const installedDir = join(installDir, 'node_modules', ...source.name.split('/'));
  const installed = JSON.parse(await readFile(join(installedDir, 'package.json'), 'utf8'));
  if (installed.name !== source.name || installed.version !== source.version || !installed.bin?.mpeek) {
    throw new Error('Packed artifact has unexpected package identity or command');
  }
  await readFile(join(installedDir, installed.bin.mpeek));
  await readFile(join(installedDir, '.output', 'server', 'index.mjs'));

  const command = join(installDir, 'node_modules', '.bin', 'mpeek');
  const smoke = spawnSync(command, [], {
    cwd: installDir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(installDir, 'node_modules', '.bin')}${delimiter}${process.env.PATH}` },
  });
  if (smoke.status !== 0 || !smoke.stdout.includes('mpeek')) {
    throw new Error(`Packed mpeek command smoke test failed:\n${smoke.stdout}${smoke.stderr}`);
  }
  if (smoke.stdout.trim().split('\n').length < 2) {
    throw new Error('Packed mpeek command did not print its complete no-argument usage');
  }

  // Stub only the browser opener in this temporary install so the packaged CLI can run its real server.
  await writeFile(join(installDir, 'node_modules', 'open', 'index.js'), 'export default async () => {};\n');
  const configHome = join(installDir, 'config');
  const accountsDir = join(configHome, 'review-master');
  await mkdir(accountsDir, { recursive: true });
  await writeFile(join(accountsDir, 'accounts.json'), JSON.stringify([{
    host: 'https://gitlab.example.com', token: 'release-smoke-test', username: 'smoke', name: 'Smoke Test',
  }]));

  const mrUrl = 'https://gitlab.example.com/group/project/-/merge_requests/1';
  const server = spawn(command, [mrUrl], {
    cwd: installDir,
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  server.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  server.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolveExit => server.once('exit', (code, signal) => resolveExit({ code, signal })));
  let firstOrigin;
  try {
    const startupDeadline = Date.now() + 15_000;
    let response;
    let endpoint;
    while (Date.now() < startupDeadline) {
      if (server.exitCode !== null) throw new Error(`Packaged CLI exited early (${server.exitCode}):\n${stdout}${stderr}`);
      endpoint = stdout.match(/at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (endpoint) {
        firstOrigin ||= endpoint;
        try {
          response = await fetch(`${endpoint}/?mr=${encodeURIComponent(mrUrl)}`);
          if (response.ok) break;
        } catch { /* Nitro has not started listening yet. */ }
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    if (!response?.ok) throw new Error(`Packed CLI did not serve its review page:\n${stdout}${stderr}`);
    const html = await response.text();
    if (!html.toLowerCase().includes('<!doctype html>')) {
      throw new Error(`Packed CLI served an unexpected response (${response.status}): ${html.slice(0, 160)}`);
    }

    server.kill('SIGTERM');
    let stopTimer;
    const result = await Promise.race([exited, new Promise((_, reject) => {
      stopTimer = setTimeout(() => reject(new Error('Packaged CLI did not stop after SIGTERM')), 5_000);
    })]);
    clearTimeout(stopTimer);
    if (result.code !== 0) throw new Error(`Packaged CLI exited unexpectedly (${result.signal ?? result.code}):\n${stderr}`);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await exited;
    }
  }

  const restartedServer = spawn(command, [mrUrl], {
    cwd: installDir,
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let restartOutput = '';
  let restartError = '';
  restartedServer.stdout.setEncoding('utf8').on('data', chunk => { restartOutput += chunk; });
  restartedServer.stderr.setEncoding('utf8').on('data', chunk => { restartError += chunk; });
  const restartExit = new Promise(resolveExit => restartedServer.once('exit', (code, signal) => resolveExit({ code, signal })));
  try {
    const restartDeadline = Date.now() + 15_000;
    let restartOrigin;
    let response;
    while (Date.now() < restartDeadline) {
      if (restartedServer.exitCode !== null) throw new Error(`Packaged CLI failed on restart (${restartedServer.exitCode}):\n${restartOutput}${restartError}`);
      restartOrigin = restartOutput.match(/at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (restartOrigin) {
        try {
          response = await fetch(`${restartOrigin}/?mr=${encodeURIComponent(mrUrl)}`);
          if (response.ok) break;
        } catch { /* Nitro has not started listening yet. */ }
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    if (!response?.ok) throw new Error(`Packaged CLI did not restart:\n${restartOutput}${restartError}`);
    if (restartOrigin !== firstOrigin) throw new Error(`Packaged CLI changed local origin after restart (${firstOrigin} → ${restartOrigin})`);
    restartedServer.kill('SIGTERM');
    let stopTimer;
    const result = await Promise.race([restartExit, new Promise((_, reject) => {
      stopTimer = setTimeout(() => reject(new Error('Restarted package did not stop after SIGTERM')), 5_000);
    })]);
    clearTimeout(stopTimer);
    if (result.code !== 0) throw new Error(`Restarted package exited unexpectedly (${result.signal ?? result.code}):\n${restartError}`);
  } finally {
    if (restartedServer.exitCode === null && restartedServer.signalCode === null) {
      restartedServer.kill('SIGKILL');
      await restartExit;
    }
  }
  console.log(`Verified ${installed.name}@${installed.version}: usage, packed CLI, live Nitro response, stable local origin across restart, clean shutdown`);
} finally {
  await rm(installDir, { recursive: true, force: true });
}
