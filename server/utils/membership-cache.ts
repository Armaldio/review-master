import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type Membership = { accessLevel: number; checkedAt: string };
type CacheEntry = { host: string; userId: number; groupPath: string } & Membership;
type CacheFile = { version: 1; entries: CacheEntry[] };

function cacheFilePath(): string {
  const configFile = process.env.REVIEW_MASTER_CONFIG || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'review-master', 'accounts.json');
  return join(dirname(configFile), 'owner-membership.json');
}

function normalize(host: string, userId: number, groupPath: string) {
  let parsedHost: URL;
  try { parsedHost = new URL(host); } catch { return null; }
  if (!['http:', 'https:'].includes(parsedHost.protocol)) return null;
  const origin = parsedHost.origin;
  const normalizedGroup = groupPath.trim().replace(/^@/, '').replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!Number.isSafeInteger(userId) || userId <= 0 || !normalizedGroup) return null;
  return { host: origin, userId, groupPath: normalizedGroup };
}

function validEntry(value: unknown): value is CacheEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CacheEntry>;
  return typeof entry.host === 'string'
    && typeof entry.groupPath === 'string'
    && Number.isSafeInteger(entry.userId) && Number(entry.userId) > 0
    && Number.isSafeInteger(entry.accessLevel) && Number(entry.accessLevel) > 0
    && typeof entry.checkedAt === 'string' && !Number.isNaN(Date.parse(entry.checkedAt));
}

async function readEntries(path: string): Promise<CacheEntry[]> {
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!data || typeof data !== 'object' || (data as Partial<CacheFile>).version !== 1 || !Array.isArray((data as Partial<CacheFile>).entries)) return [];
    return (data as CacheFile).entries.filter(validEntry);
  } catch {
    // The cache is advisory; missing, unreadable, or corrupt files are misses.
    return [];
  }
}

let writeQueue: Promise<void> = Promise.resolve();

function updateEntries(path: string, update: (entries: CacheEntry[]) => CacheEntry[]): Promise<void> {
  const operation = writeQueue.then(async () => {
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const entries = update(await readEntries(path));
      const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, entries } satisfies CacheFile)}\n`, { mode: 0o600, flag: 'wx' });
        await chmod(temporary, 0o600);
        await rename(temporary, path);
        await chmod(path, 0o600);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    } catch {
      // A failed cache write must not fail CODEOWNERS verification.
    }
  });
  writeQueue = operation;
  return operation;
}

export async function readMembership(host: string, userId: number, groupPath: string): Promise<Membership | null> {
  const key = normalize(host, userId, groupPath);
  if (!key) return null;
  const entry = (await readEntries(cacheFilePath())).find(value => value.host === key.host && value.userId === key.userId && value.groupPath === key.groupPath);
  return entry ? { accessLevel: entry.accessLevel, checkedAt: entry.checkedAt } : null;
}

export async function writeMembership(host: string, userId: number, groupPath: string, accessLevel: number): Promise<void> {
  const key = normalize(host, userId, groupPath);
  if (!key || !Number.isSafeInteger(accessLevel) || accessLevel <= 0) return;
  const entry: CacheEntry = { ...key, accessLevel, checkedAt: new Date().toISOString() };
  return updateEntries(cacheFilePath(), entries => [
    ...entries.filter(value => value.host !== key.host || value.userId !== key.userId || value.groupPath !== key.groupPath),
    entry,
  ]);
}

export async function deleteMembership(host: string, userId: number, groupPath: string): Promise<void> {
  const key = normalize(host, userId, groupPath);
  if (!key) return;
  return updateEntries(cacheFilePath(), entries => entries.filter(value => value.host !== key.host || value.userId !== key.userId || value.groupPath !== key.groupPath));
}
