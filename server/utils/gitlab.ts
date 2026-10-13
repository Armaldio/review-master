import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { H3Event } from 'h3';

const execFileAsync = promisify(execFile);

export type MergeRequestUrl = { host: string; projectPath: string; iid: string; encodedProject: string };
export type Account = { host: string; token: string; username: string; name?: string };

export function parseMergeRequestUrl(value: string): MergeRequestUrl {
  let url: URL;
  try { url = new URL(value); } catch { throw createError({ statusCode: 400, statusMessage: 'Enter a valid GitLab merge request URL' }); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw createError({ statusCode: 400, statusMessage: 'Merge request URL must be HTTP(S) without credentials' });
  const match = url.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)\/?$/);
  if (!match) throw createError({ statusCode: 400, statusMessage: 'Expected a GitLab URL ending in /-/merge_requests/<iid>' });
  const projectPath = decodeURIComponent(match[1]!);
  if (projectPath.split('/').some(part => !part || part === '.' || part === '..')) throw createError({ statusCode: 400, statusMessage: 'Invalid GitLab project path' });
  return { host: url.origin, projectPath, iid: match[2]!, encodedProject: encodeURIComponent(projectPath) };
}

export async function getAccounts(): Promise<Account[]> {
  const path = process.env.REVIEW_MASTER_CONFIG;
  if (!path) return [];
  try { return JSON.parse(await readFile(path, 'utf8')) as Account[]; }
  catch { throw createError({ statusCode: 503, statusMessage: 'Unable to read GitLab accounts' }); }
}

type GlabRunner = (hostname: string, env?: NodeJS.ProcessEnv) => Promise<string>;

function glabEnvironmentForHost(hostname: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  const defaultHost = env.GITLAB_HOST || env.GITLAB_URI || env.GL_HOST || 'gitlab.com';
  let configuredHost = '';
  try { configuredHost = new URL(defaultHost.includes('://') ? defaultHost : `https://${defaultHost}`).host.toLowerCase(); }
  catch { /* Invalid host configuration cannot authorize an environment token. */ }
  if (configuredHost !== hostname.toLowerCase()) {
    delete env.GITLAB_TOKEN;
    delete env.GITLAB_ACCESS_TOKEN;
    delete env.OAUTH_TOKEN;
  }
  return env;
}

async function runGlabConfig(hostname: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const { stdout } = await execFileAsync('glab', ['config', 'get', 'token', '--host', hostname], {
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      env: { ...env, NO_COLOR: '1' },
    });
    return stdout.trim();
  } catch (error) {
    // glab may provide useful stdout alongside a non-zero status, but never
    // expose its stderr or error text to the web application.
    const result = error as { stdout?: string; stderr?: string };
    return (result.stdout || '').trim();
  }
}

export async function resolveGitLabToken(host: string, legacyToken?: string, runGlab: GlabRunner = runGlabConfig, verify: (host: string, token: string) => Promise<boolean> = verifyGitLabToken): Promise<string> {
  const hostname = new URL(host).host;
  let token = '';
  try { token = (await runGlab(hostname, glabEnvironmentForHost(hostname))).trim(); } catch { /* Fall back to legacy account configuration below. */ }
  if (token && await verify(host, token)) return token;
  if (legacyToken && await verify(host, legacyToken)) return legacyToken;
  throw createError({
    statusCode: 503,
    statusMessage: `No GitLab authentication found for ${hostname}. Run glab auth login --hostname ${hostname} and try again.`,
  });
}

async function verifyGitLabToken(host: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${host}/api/v4/user`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch { return false; }
}

export async function getGitLabContext(event: H3Event, value: string) {
  const mr = parseMergeRequestUrl(value);
  const requestHost = getRequestHeader(event, 'host');
  const requestOrigin = getRequestHeader(event, 'origin');
  const requestHostname = requestHost?.split(':')[0]?.toLowerCase();
  const allowedHosts = new Set(['127.0.0.1', 'localhost', ...(process.env.REVIEW_MASTER_ALLOWED_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean)]);
  if (!requestHostname || !allowedHosts.has(requestHostname)) throw createError({ statusCode: 403, statusMessage: 'Request host is not trusted' });
  if (requestOrigin && new URL(requestOrigin).host !== requestHost) throw createError({ statusCode: 403, statusMessage: 'Cross-origin request rejected' });
  let legacyAccount: Account | undefined;
  try { legacyAccount = (await getAccounts()).find(item => item.host === mr.host); }
  catch { /* glab authentication remains usable when old account metadata is unreadable. */ }
  const token = await resolveGitLabToken(mr.host, legacyAccount?.token);
  const account: Account = { host: mr.host, token, username: legacyAccount?.username || '', ...(legacyAccount?.name ? { name: legacyAccount.name } : {}) };
  return { mr, account, base: `${mr.host}/api/v4/projects/${mr.encodedProject}/merge_requests/${mr.iid}` };
}

export async function gitlab<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, redirect: 'manual', headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  if (response.status >= 300 && response.status < 400) throw createError({ statusCode: 502, statusMessage: 'GitLab redirected the API request; credentials were withheld' });
  if (!response.ok) {
    let stalePosition = false;
    if (response.status === 400) {
      try {
        const body = await response.json() as { message?: unknown };
        stalePosition = typeof body.message === 'string' && /position.{0,40}(?:outdated|stale)|(?:outdated|stale).{0,40}position/i.test(body.message);
      } catch { /* Keep other upstream error details private. */ }
    }
    throw createError({
      statusCode: response.status === 429 ? 429 : response.status,
      statusMessage: stalePosition ? 'The comment position is out of date. Refresh the merge request and reselect the line.' : `GitLab returned ${response.status}`,
      data: { retryAfter: response.headers.get('retry-after') },
    });
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function validatePreviewUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

type Deployment = { id: number; sha?: string; ref?: string; status?: string; finished_at?: string; environment?: { name?: string; id?: number }; deployable?: { sha?: string; ref?: string; status?: string } };
type Environment = { id: number; name: string; external_url?: string; state?: string; tier?: string };

export async function discoverPreviews(host: string, projectPath: string, token: string, headSha: string, sourceBranch: string) {
  const project = encodeURIComponent(projectPath);
  const api = `${host}/api/v4/projects/${project}`;
  const deployments: Deployment[] = [];
  for (let page = 1; page <= 3; page++) {
    const rows = await gitlab<Deployment[]>(`${api}/deployments?status=success&order_by=finished_at&sort=desc&per_page=100&page=${page}`, token);
    deployments.push(...rows);
    if (rows.length < 100) break;
  }
  const envRows = await gitlab<Environment[]>(`${api}/environments?states=available&per_page=100`, token);
  const environments = new Map(envRows.map(env => [env.id, env]));
  return deployments.flatMap(deployment => {
    const env = deployment.environment?.id ? environments.get(deployment.environment.id) : envRows.find(item => item.name === deployment.environment?.name);
    const url = validatePreviewUrl(env?.external_url);
    if (!url || !env || env.state === 'stopped' || ['production', 'staging'].includes((env.tier || '').toLowerCase()) || /^(production|staging)(\/|$)/i.test(env.name)) return [];
    const sha = deployment.sha || deployment.deployable?.sha || '';
    const ref = deployment.ref || deployment.deployable?.ref || '';
    const exact = Boolean(headSha && sha === headSha);
    const branch = Boolean(sourceBranch && ref === sourceBranch);
    if (!exact && !branch) return [];
    return [{ url, environment: env.name, sha, ref, finishedAt: deployment.finished_at, match: exact ? 'exact' : 'branch', stale: !exact }];
  }).sort((a, b) => Number(a.stale) - Number(b.stale) || (Date.parse(b.finishedAt || '') - Date.parse(a.finishedAt || '')));
}
