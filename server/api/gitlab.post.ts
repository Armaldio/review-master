import { discoverPreviews, getGitLabContext, gitlab, validatePreviewUrl } from '../utils/gitlab.ts';

type Mr = { id: number; title: string; description: string; state: string; web_url: string; source_branch: string; target_branch: string; sha: string; diff_refs?: { base_sha: string; head_sha: string; start_sha: string }; draft?: boolean; author: { username: string; name: string }; project_id: number; source_project_id: number; target_project_id: number };
type Diff = { old_path: string; new_path: string; diff: string; new_file: boolean; deleted_file: boolean; renamed_file: boolean; collapsed?: boolean; too_large?: boolean; a_mode?: string; b_mode?: string };
const json = (value: unknown) => JSON.stringify(value);

export default defineEventHandler(async event => {
  const body = await readBody<{ mrUrl?: string; action?: string; payload?: Record<string, any> }>(event);
  if (!body?.mrUrl || !body.action) throw createError({ statusCode: 400, statusMessage: 'mrUrl and action are required' });
  const { mr, account, base } = await getGitLabContext(event, body.mrUrl);
  const token = account.token;
  const project = `${mr.host}/api/v4/projects/${mr.encodedProject}`;
  const detail = () => gitlab<Mr>(base, token);

  switch (body.action) {
    case 'bootstrap': {
      const [info, user, projectInfo, diffs, discussions, draftNotes] = await Promise.all([
        detail(),
        gitlab<any>(`${mr.host}/api/v4/user`, token),
        gitlab<any>(project, token),
        gitlabPages<Diff>(`${base}/diffs`, token),
        gitlabPages<any>(`${base}/discussions`, token),
        gitlabPages<any>(`${base}/draft_notes`, token),
      ]);
      const owners = await loadCodeowners(project, info.target_branch, token);
      const ownership = await verifyOwners(owners.rules, user, projectInfo, token, mr.host);
      const heads = await mapLimit(diffs, 6, async file => {
        if (file.deleted_file) return { path: file.old_path, sha: 'deleted' };
        try {
          const response = await fetch(`${project}/repository/files/${encodeURIComponent(file.new_path)}?ref=${encodeURIComponent(info.sha)}`, { method: 'HEAD', headers: { 'PRIVATE-TOKEN': token }, redirect: 'manual' });
          if (!response.ok) return { path: file.new_path, sha: null };
          return { path: file.new_path, sha: response.headers.get('x-gitlab-blob-id') || response.headers.get('x-gitlab-content-sha256') };
        } catch { return { path: file.new_path, sha: null }; }
      });
      return {
        mr: { ...info, diff_refs: info.diff_refs || {} }, user: { id: user.id, username: user.username, name: user.name },
        project: { id: projectInfo.id, path: projectInfo.path_with_namespace, namespace: projectInfo.namespace?.full_path },
        diffs: diffs.map(file => ({ ...file, identity: heads.find(head => head.path === (file.deleted_file ? file.old_path : file.new_path))?.sha ?? null })),
        discussions, draftNotes, codeowners: owners.rules, ownerStatus: ownership.status, ownerWarning: owners.warning || ownership.warning,
      };
    }
    case 'refresh': {
      const [info, discussions, draftNotes] = await Promise.all([detail(), gitlabPages<any>(`${base}/discussions`, token), gitlabPages<any>(`${base}/draft_notes`, token)]);
      return { mr: info, discussions, draftNotes };
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
      const response = await fetch(`${project}/repository/files/${path}/raw?ref=${encodeURIComponent(ref)}`, { headers: { 'PRIVATE-TOKEN': token }, redirect: 'manual' });
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

async function loadCodeowners(project: string, targetBranch: string, token: string): Promise<{ rules: { pattern: string; owners: string[]; section?: string }[]; warning?: string }> {
  for (const path of ['CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS']) {
    const url = `${project}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(targetBranch)}`;
    const response = await fetch(url, { headers: { 'PRIVATE-TOKEN': token }, redirect: 'manual' });
    if (response.ok) return parseCodeowners(await response.text());
    if (![404, 400].includes(response.status)) return { rules: [], warning: 'CODEOWNERS could not be verified; showing all files.' };
  }
  return { rules: [], warning: 'No CODEOWNERS file found on the target branch.' };
}

function parseCodeowners(source: string) {
  const rules: { pattern: string; owners: string[]; section?: string }[] = [];
  let section = '';
  try {
    for (const raw of source.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const heading = line.match(/^\^?\[([^\]]+)\](?:\[\d+\])?(?:\s+(.+))?$/);
      if (heading) {
        section = heading[1]!.trim();
        if (heading[2]) rules.push({ pattern: '**', owners: heading[2].trim().split(/\s+/), section });
        continue;
      }
      const parts = line.split(/\s+/);
      if (parts.length < 2 || parts[0]?.startsWith('!')) return { rules: [], warning: 'CODEOWNERS contains unsupported syntax; showing all files.' };
      rules.push({ pattern: parts.shift()!, owners: parts, ...(section ? { section } : {}) });
    }
    return { rules };
  } catch { return { rules: [], warning: 'CODEOWNERS could not be parsed; showing all files.' }; }
}

async function verifyOwners(rules: { owners: string[] }[], user: any, project: any, token: string, host: string) {
  const roles: Record<string, number> = { guest: 10, planner: 15, reporter: 20, developer: 30, maintainer: 40, owner: 50 };
  const status: Record<string, boolean | null> = {};
  const roleLevel = project.permissions?.project_access?.access_level || project.permissions?.group_access?.access_level || 0;
  for (const owner of new Set(rules.flatMap(rule => rule.owners))) {
    const normalized = owner.replace(/^@/, '').toLowerCase();
    if (!owner.startsWith('@')) { status[owner] = user.email?.toLowerCase() === normalized ? true : null; continue; }
    const groupRole = owner.match(/^@(.+)%([a-z]+)$/i);
    if (owner.startsWith('@@')) {
      const role = owner.slice(2).toLowerCase();
      status[owner] = roles[role] ? roleLevel >= roles[role] : null;
      continue;
    }
    if (!groupRole && normalized === String(user.username).toLowerCase()) { status[owner] = true; continue; }
    const groupPath = groupRole?.[1] || normalized;
    const requiredLevel = groupRole ? roles[groupRole[2]!.toLowerCase()] : 0;
    if (groupRole && !requiredLevel) { status[owner] = null; continue; }
    try {
      const members = await gitlab<any[]>(`${host}/api/v4/groups/${encodeURIComponent(groupPath)}/members?query=${encodeURIComponent(user.username)}&per_page=100`, token);
      const member = members.find(item => String(item.id) === String(user.id));
      status[owner] = member ? member.access_level >= (requiredLevel || 0) : false;
    } catch { status[owner] = null; }
  }
  return { status, ...(Object.values(status).includes(null) ? { warning: 'Some CODEOWNERS groups or roles could not be verified; showing all files.' } : {}) };
}
