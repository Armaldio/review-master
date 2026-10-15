import { discoverPreviews, getGitLabContext, gitlab, validatePreviewUrl } from '../utils/gitlab.ts';
import { logReviewActivity } from '../utils/review-activity.ts';
import { readMembership, writeMembership, deleteMembership } from '../utils/membership-cache.ts';
import { codeownersForPath, parseCodeowners } from '../../shared/codeowners.ts';

type Mr = { id: number; title: string; description: string; state: string; web_url: string; source_branch: string; target_branch: string; sha: string; diff_refs?: { base_sha: string; head_sha: string; start_sha: string }; draft?: boolean; author: { username: string; name: string }; project_id: number; source_project_id: number; target_project_id: number };
type Diff = { old_path: string; new_path: string; diff: string; new_file: boolean; deleted_file: boolean; renamed_file: boolean; collapsed?: boolean; too_large?: boolean; a_mode?: string; b_mode?: string };
type DiffVersion = { id: number; created_at: string; head_commit_sha: string; base_commit_sha: string; start_commit_sha: string; state?: string; real_size?: string };
type VersionDiff = DiffVersion & { diffs?: Diff[] };
type CompareResult = { diffs?: Diff[]; compare_timeout?: boolean; compare_same_ref?: boolean };
const json = (value: unknown) => JSON.stringify(value);
const ownerMembershipRequests = new Map<string, Promise<{ accessLevel: number; checkedAt: string } | null>>();

function requireDiffVersions(versions: DiffVersion[]): DiffVersion[] {
  if (!Array.isArray(versions) || !versions.length) {
    throw createError({ statusCode: 502, statusMessage: 'GitLab did not return any stored merge request diff versions. Refresh the merge request and try again.' });
  }
  const ids = new Set<number>();
  for (const version of versions) {
    if (!Number.isSafeInteger(version?.id) || version.id <= 0 || ids.has(version.id)
      || typeof version.head_commit_sha !== 'string' || !version.head_commit_sha
      || typeof version.base_commit_sha !== 'string' || !version.base_commit_sha
      || typeof version.start_commit_sha !== 'string' || !version.start_commit_sha) {
      throw createError({ statusCode: 502, statusMessage: 'GitLab returned incomplete push version history. Refresh the merge request and try again.' });
    }
    ids.add(version.id);
  }
  return versions;
}

async function diffForVersion(base: string, project: string, token: string, versions: DiffVersion[], versionId: number) {
  const index = versions.findIndex(version => version.id === versionId);
  if (index < 0) throw createError({ statusCode: 404, statusMessage: 'This merge request push version is no longer available. Refresh history and select an available version.' });
  const version = versions[index]!;
  const versionUrl = `${base}/versions/${version.id}`;
  const snapshot = await gitlab<VersionDiff>(versionUrl, token);
  if (snapshot.id !== version.id || snapshot.head_commit_sha !== version.head_commit_sha) {
    throw createError({ statusCode: 502, statusMessage: `GitLab returned stale data for push version ${version.id}. Refresh history and try again.` });
  }
  if (snapshot.state && snapshot.state !== 'collected') {
    throw createError({ statusCode: 502, statusMessage: `GitLab has not collected a complete diff for push version ${version.id}.` });
  }

  const previous = versions[index + 1];
  let diffs: Diff[];
  let refs: { base_sha: string; head_sha: string; start_sha: string };
  if (previous) {
    const from = previous.head_commit_sha;
    const to = version.head_commit_sha;
    const comparison = await gitlab<CompareResult>(`${project}/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&straight=true`, token);
    if (comparison.compare_timeout || !Array.isArray(comparison.diffs)) {
      throw createError({ statusCode: 502, statusMessage: `GitLab could not return a complete version diff for push ${version.id}. Refresh history and try again.` });
    }
    diffs = comparison.diffs;
    refs = { base_sha: from, head_sha: to, start_sha: from };
  } else {
    if (!Array.isArray(snapshot.diffs)) {
      throw createError({ statusCode: 502, statusMessage: `GitLab could not return the initial diff for push version ${version.id}. Refresh history and try again.` });
    }
    diffs = snapshot.diffs;
    refs = { base_sha: version.base_commit_sha, head_sha: version.head_commit_sha, start_sha: version.start_commit_sha };
  }

  return {
    selectedVersionId: version.id,
    versionIsInitial: !previous,
    versions,
    mrDiffRefs: refs,
    mrSha: version.head_commit_sha,
    diffs: diffs.map(file => ({ ...file, identity: file.deleted_file ? 'deleted' : null })),
  };
}

export default defineEventHandler(async event => {
  const body = await readBody<{ mrUrl?: string; action?: string; payload?: Record<string, any> }>(event);
  if (!body?.mrUrl || !body.action) throw createError({ statusCode: 400, statusMessage: 'mrUrl and action are required' });
  const { mr, account, base, user } = await getGitLabContext(event, body.mrUrl);
  const token = account.token;
  const project = `${mr.host}/api/v4/projects/${mr.encodedProject}`;
  const detail = () => gitlab<Mr>(base, token);

  switch (body.action) {
    case 'bootstrap': {
      const [info, listedVersions] = await Promise.all([
        detail(),
        gitlabPages<DiffVersion>(`${base}/versions`, token),
      ]);
      const versions = requireDiffVersions(listedVersions);
      const selected = await diffForVersion(base, project, token, versions, versions[0]!.id);
      return {
        mr: { ...info, sha: selected.mrSha, diff_refs: selected.mrDiffRefs }, user: { id: user.id, username: user.username, name: user.name },
        project: { id: info.project_id },
        diffs: selected.diffs,
        versions: selected.versions,
        selectedVersionId: selected.selectedVersionId,
        versionIsInitial: selected.versionIsInitial,
        discussions: [], draftNotes: [], codeowners: [], ownerStatus: {},
      };
    }
    case 'version-diff': {
      const requested = body.payload?.versionId;
      const validInput = typeof requested === 'number' || typeof requested === 'string' && /^\d+$/.test(requested);
      const versionId = typeof requested === 'number' ? requested : validInput ? Number(requested) : NaN;
      if (!validInput || !Number.isSafeInteger(versionId) || versionId <= 0) throw createError({ statusCode: 400, statusMessage: 'A valid GitLab push version is required.' });
      const [info, listedVersions] = await Promise.all([detail(), gitlabPages<DiffVersion>(`${base}/versions`, token)]);
      const versions = requireDiffVersions(listedVersions);
      const selected = await diffForVersion(base, project, token, versions, versionId);
      return {
        mr: { ...info, sha: selected.mrSha, diff_refs: selected.mrDiffRefs },
        diffs: selected.diffs,
        versions: selected.versions,
        selectedVersionId: selected.selectedVersionId,
        versionIsInitial: selected.versionIsInitial,
      };
    }
    case 'file-identities': {
      const paths = Array.isArray(body.payload?.paths)
        ? [...new Set(body.payload.paths.filter((path): path is string => typeof path === 'string' && path.length > 0 && path.length <= 4096).slice(0, 1000))]
        : [];
      const sha = typeof body.payload?.sha === 'string' ? body.payload.sha : '';
      if (!sha || sha.length > 128) throw createError({ statusCode: 400, statusMessage: 'A valid merge request head SHA is required' });
      const files = paths.map(path => ({ old_path: path, new_path: path, diff: '', new_file: false, deleted_file: false, renamed_file: false }));
      const identities = await fileIdentities(files, project, sha, token);
      return { identities: Object.fromEntries(identities.map(item => [item.path, item.sha])) };
    }
    case 'verify-owners': {
      const paths = Array.isArray(body.payload?.paths)
        ? [...new Set(body.payload.paths.filter((path): path is string => typeof path === 'string' && path.length <= 4096).slice(0, 1000))]
        : [];
      const targetBranch = typeof body.payload?.targetBranch === 'string' ? body.payload.targetBranch : '';
      const refreshMemberships = body.payload?.refreshMemberships === true;
      const [projectInfo, owners] = await Promise.all([
        gitlab<any>(project, token),
        targetBranch ? loadCodeowners(project, targetBranch, token) : Promise.resolve({ rules: [], warning: 'CODEOWNERS could not be verified; showing all files.' }),
      ]);
      const relevantOwners = [...new Set(paths.flatMap(path => codeownersForPath(owners.rules, path).owners))];
      const ownership = await verifyOwners(relevantOwners, user, projectInfo, token, mr.host, refreshMemberships);
      return { codeowners: owners.rules, ownerStatus: ownership.status, ownerWarning: owners.warning, membershipCheckedAt: ownership.membershipCheckedAt };
    }
    case 'refresh': {
      const [info, listedVersions, discussions, draftNotes] = await Promise.all([detail(), gitlabPages<DiffVersion>(`${base}/versions`, token), gitlabPages<any>(`${base}/discussions`, token), gitlabPages<any>(`${base}/draft_notes`, token)]);
      const versions = requireDiffVersions(listedVersions);
      if (process.env.REVIEW_MASTER_CLI === '1') logReviewActivity(`${mr.host}/${mr.projectPath}/${mr.iid}`, info, discussions);
      return { mr: info, versions, discussions, draftNotes };
    }
    case 'preview': {
      const info = await detail();
        return { previews: await discoverPreviews(mr.host, mr.projectPath, token, info.sha, info.source_project_id === info.target_project_id ? info.source_branch : '') };
    }
    case 'files': {
      const info = await detail();
      const filePath = String(body.payload?.path || '');
      const ref = String(body.payload?.ref || info.sha);
      const path = encodeURIComponent(filePath);
      const response = await fetch(`${project}/repository/files/${path}/raw?ref=${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) throw createError({ statusCode: 502, statusMessage: 'GitLab redirected a file request' });
      if (!response.ok) throw createError({ statusCode: response.status, statusMessage: `Could not load file (${response.status})` });
      return { content: await response.text() };
    }
    case 'comment': {
      const data = body.payload || {};
      if (typeof data.body !== 'string' || !data.body.trim()) throw createError({ statusCode: 400, statusMessage: 'Comment text is required' });
      if (data.draft) return gitlab(`${base}/draft_notes`, token, { method: 'POST', body: json({ note: data.body, ...(data.discussionId ? { in_reply_to_discussion_id: data.discussionId } : {}), ...(data.position ? { position: data.position } : {}) }) });
      return gitlab(`${base}/discussions`, token, { method: 'POST', body: json({ body: data.body, ...(data.discussionId ? { in_reply_to_discussion_id: data.discussionId } : {}), ...(data.position ? { position: data.position } : {}) }) });
    }
    case 'edit-comment': {
      const { discussionId, noteId, body: note } = body.payload || {};
      return gitlab(`${base}/discussions/${encodeURIComponent(discussionId)}/notes/${encodeURIComponent(noteId)}`, token, { method: 'PUT', body: json({ body: note }) });
    }
    case 'edit-draft-note': {
      const { draftNoteId, note } = body.payload || {};
      if (typeof note !== 'string' || !note.trim()) throw createError({ statusCode: 400, statusMessage: 'Draft note text is required' });
      return gitlab(`${base}/draft_notes/${encodeURIComponent(draftNoteId)}`, token, { method: 'PUT', body: json({ note }) });
    }
    case 'delete-draft-note': {
      const { draftNoteId } = body.payload || {};
      return gitlab(`${base}/draft_notes/${encodeURIComponent(draftNoteId)}`, token, { method: 'DELETE' });
    }
    case 'delete-comment': {
      const { discussionId, noteId } = body.payload || {};
      return gitlab(`${base}/discussions/${encodeURIComponent(discussionId)}/notes/${encodeURIComponent(noteId)}`, token, { method: 'DELETE' });
    }
    case 'resolve': {
      const { discussionId, resolved } = body.payload || {};
      return gitlab(`${base}/discussions/${encodeURIComponent(discussionId)}?resolved=${Boolean(resolved)}`, token, { method: 'PUT', body: json({ resolved: Boolean(resolved) }) });
    }
    case 'reply': {
      const { discussionId, body: note, draft } = body.payload || {};
      if (draft) return gitlab(`${base}/draft_notes`, token, { method: 'POST', body: json({ note, in_reply_to_discussion_id: discussionId }) });
      return gitlab(`${base}/discussions/${encodeURIComponent(discussionId)}/notes`, token, { method: 'POST', body: json({ body: note }) });
    }
    case 'reaction': {
      const { noteId, emoji, remove } = body.payload || {};
      const baseUrl = `${mr.host}/api/v4/projects/${mr.encodedProject}/merge_requests/${mr.iid}/notes/${encodeURIComponent(noteId)}/award_emoji`;
      return gitlab(remove ? `${baseUrl}/${encodeURIComponent(body.payload?.awardId)}` : baseUrl, token, { method: remove ? 'DELETE' : 'POST', ...(!remove ? { body: json({ name: emoji }) } : {}) });
    }
    case 'publish-drafts':
      return gitlab(`${base}/draft_notes/bulk_publish`, token, { method: 'POST', body: '{}' });
    case 'approve':
      return gitlab(`${base}/approve`, token, { method: 'POST', body: '{}' });
    case 'unapprove':
      return gitlab(`${base}/unapprove`, token, { method: 'POST', body: '{}' });
    case 'ready':
      return gitlab(`${base}/notes`, token, { method: 'POST', body: json({ body: '/ready' }) });
    case 'summary': {
      const note = String(body.payload?.body || '');
      if (!note.trim()) throw createError({ statusCode: 400, statusMessage: 'Summary text is required' });
      return gitlab(`${mr.host}/api/v4/projects/${mr.encodedProject}/merge_requests/${mr.iid}/notes`, token, { method: 'POST', body: json({ body: note }) });
    }
    case 'request-changes': {
      const note = String(body.payload?.body || '');
      if (!note.trim()) throw createError({ statusCode: 400, statusMessage: 'Explain the requested changes first' });
      return gitlab(`${mr.host}/api/v4/projects/${mr.encodedProject}/merge_requests/${mr.iid}/notes`, token, { method: 'POST', body: json({ body: `${note}\n\n/submit_review requested_changes` }) });
    }
    case 'open-preview': {
      const url = validatePreviewUrl(body.payload?.url);
      if (!url) throw createError({ statusCode: 400, statusMessage: 'Invalid preview URL' });
      if (new URL(url).protocol === 'http:' && body.payload?.confirmedHttp !== true) throw createError({ statusCode: 400, statusMessage: 'HTTP preview requires explicit confirmation' });
      return { url };
    }
    default: throw createError({ statusCode: 400, statusMessage: 'Unknown GitLab action' });
  }
});

async function gitlabPages<T>(url: string, token: string, maxPages = 10): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = await gitlab<T[]>(`${url}?per_page=100&page=${page}`, token);
    if (!Array.isArray(rows)) throw createError({ statusCode: 502, statusMessage: 'GitLab returned an invalid paginated response. Refresh and try again.' });
    result.push(...rows);
    if (rows.length < 100) break;
  }
  return result;
}

async function mapLimit<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await map(items[index]!);
    }
  }));
  return result;
}

async function fileIdentities(diffs: Diff[], project: string, sha: string, token: string) {
  return mapLimit(diffs, 6, async file => {
    if (file.deleted_file) return { path: file.old_path, sha: 'deleted' };
    try {
      const response = await fetch(`${project}/repository/files/${encodeURIComponent(file.new_path)}?ref=${encodeURIComponent(sha)}`, { method: 'HEAD', headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
      if (!response.ok) return { path: file.new_path, sha: null };
      return { path: file.new_path, sha: response.headers.get('x-gitlab-blob-id') || response.headers.get('x-gitlab-content-sha256') };
    } catch { return { path: file.new_path, sha: null }; }
  });
}

async function loadCodeowners(project: string, targetBranch: string, token: string): Promise<{ rules: { pattern: string; owners: string[]; section?: string; exclude?: boolean }[]; warning?: string }> {
  const read = (path: string) => {
    const url = `${project}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(targetBranch)}`;
    return fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
  };
  const root = await read('CODEOWNERS');
  if (root.ok) return parseCodeowners(await root.text());
  if (![404, 400].includes(root.status)) return { rules: [], warning: 'CODEOWNERS could not be verified; showing all files.' };

  const [docs, gitlab] = await Promise.all([read('docs/CODEOWNERS').catch(() => null), read('.gitlab/CODEOWNERS').catch(() => null)]);
  for (const response of [docs, gitlab]) {
    if (!response) return { rules: [], warning: 'CODEOWNERS could not be verified; showing all files.' };
    if (response.ok) return parseCodeowners(await response.text());
    if (![404, 400].includes(response.status)) return { rules: [], warning: 'CODEOWNERS could not be verified; showing all files.' };
  }
  return { rules: [], warning: 'No CODEOWNERS file found on the target branch.' };
}

function normalizeGroupPath(path: string) { return path.replace(/^@/, '').trim().replace(/^\/+|\/+$/g, '').toLowerCase(); }

async function groupOwnerMembership(groupPath: string, userId: number, token: string, host: string, refresh: boolean) {
  const normalizedPath = normalizeGroupPath(groupPath);
  if (!normalizedPath) return null;
  if (!refresh) {
    const cached = await readMembership(host, userId, normalizedPath);
    if (cached) return cached;
  }
  const key = `${host}\0${userId}\0${normalizedPath}`;
  const pending = ownerMembershipRequests.get(key);
  if (pending) return pending;

  const request = (async () => {
    try {
      const response = await fetch(`${host}/api/v4/groups/${encodeURIComponent(normalizedPath)}/members/all/${encodeURIComponent(String(userId))}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
      // A 404 can mean either no membership or an inaccessible/missing group, so it is not cacheable evidence.
      if (!response.ok) return null;
      const member = await response.json() as { access_level?: number };
      if (!Number.isInteger(member.access_level) || member.access_level! <= 0) return null;
      const checkedAt = new Date().toISOString();
      await writeMembership(host, userId, normalizedPath, member.access_level!);
      return { accessLevel: member.access_level!, checkedAt };
    } catch { return null; }
  })();
  ownerMembershipRequests.set(key, request);
  try { return await request; }
  finally { if (ownerMembershipRequests.get(key) === request) ownerMembershipRequests.delete(key); }
}

async function verifyOwners(owners: string[], user: any, project: any, token: string, host: string, refreshMemberships = false) {
  const roles: Record<string, number> = { guest: 10, planner: 15, reporter: 20, developer: 30, maintainer: 40, owner: 50 };
  const roleLevel = project.permissions?.project_access?.access_level || project.permissions?.group_access?.access_level || 0;
  const groupPaths = [...new Set(owners.flatMap(owner => {
    if (!owner.startsWith('@') || owner.startsWith('@@')) return [];
    const groupRole = owner.match(/^@(.+)%([a-z]+)$/i);
    const normalized = normalizeGroupPath(groupRole?.[1] || owner);
    return !groupRole && normalized === String(user.username).toLowerCase() ? [] : normalized ? [normalized] : [];
  }))];
  if (refreshMemberships) await Promise.all(groupPaths.map(groupPath => deleteMembership(host, Number(user.id), groupPath)));
  const checkedAtByGroup = new Map<string, string>();
  const results = await mapLimit([...new Set(owners)], 12, async owner => {
    const normalized = owner.replace(/^@/, '').toLowerCase();
    if (!owner.startsWith('@')) return [owner, user.email ? user.email.toLowerCase() === normalized : null] as const;
    const groupRole = owner.match(/^@(.+)%([a-z]+)$/i);
    if (owner.startsWith('@@')) {
      const role = owner.slice(2).toLowerCase();
      return [owner, roles[role] ? roleLevel >= roles[role] : null] as const;
    }
    if (!groupRole && normalized === String(user.username).toLowerCase()) return [owner, true] as const;
    const groupPath = groupRole?.[1] || normalized;
    const requiredLevel = groupRole ? roles[groupRole[2]!.toLowerCase()] : 0;
    if (groupRole && !requiredLevel) return [owner, null] as const;
    const membership = await groupOwnerMembership(groupPath, Number(user.id), token, host, refreshMemberships);
    if (membership) checkedAtByGroup.set(normalizeGroupPath(groupPath), membership.checkedAt);
    return [owner, membership ? membership.accessLevel >= (requiredLevel || 0) : null] as const;
  });
  const status: Record<string, boolean | null> = {};
  for (const [owner, value] of results) status[owner] = value;
  const membershipCheckedAt = [...checkedAtByGroup.values()].sort().at(-1) || null;
  return { status, membershipCheckedAt };
}
