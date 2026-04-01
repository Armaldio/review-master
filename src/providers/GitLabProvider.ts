import { BaseProvider } from './BaseProvider';
import { Comment, DiffFile, MRMetadata, CodeownerRule, User, MRShortMetadata, Account } from './types';
import { useStorage } from '@vueuse/core';

export class GitLabProvider extends BaseProvider {
  public platform: 'gitlab' = 'gitlab' as const;
  public mrData: MRMetadata | null = null;
  public diffs: DiffFile[] = [];
  public currentUser: User | null = null;
  public codeownersRules: CodeownerRule[] = [];
  public remoteComments: Comment[] = [];

  constructor(account?: Account) {
    super(account);
  }
  
  // Persistent cache for group memberships (24h TTL)
  private membershipCache = useStorage<Record<string, { isMember: boolean; timestamp: number }>>('gitlab-membership-cache', {});
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in ms

  public async initialize(parsed: { host: string; projectPath: string; number: string }): Promise<void> {
    const pat = await this.getPat();
    if (!pat) throw new Error('No GitLab PAT found. Go to Settings.');

    const host = parsed.host || this.host;
    const { projectPath, number: mrIid } = parsed;
    const encodedProjectPath = encodeURIComponent(projectPath);

    // Fetch Diffs
    const rawDiffs = await this.fetchAll(`${host}/api/v4/projects/${encodedProjectPath}/merge_requests/${mrIid}/diffs`, pat);
    this.diffs = rawDiffs.map((d: any) => ({
      ...d,
      sha: d.new_id || d.am_id || '' // GitLab uses new_id for the blob sha
    }));

    // Fetch MR info
    const infoRes = await fetch(`${host}/api/v4/projects/${encodedProjectPath}/merge_requests/${mrIid}`, {
      headers: { 'PRIVATE-TOKEN': pat }
    });
    const mrInfo = await infoRes.json();

    // Fetch versions
    const versionsRes = await fetch(`${host}/api/v4/projects/${encodedProjectPath}/merge_requests/${mrIid}/versions`, {
      headers: { 'PRIVATE-TOKEN': pat }
    });
    const versions = await versionsRes.json();
    const latestVersion = versions[0];

    // Fetch User
    const userRes = await fetch(`${host}/api/v4/user`, {
      headers: { 'PRIVATE-TOKEN': pat }
    });
    if (!userRes.ok) throw new Error('Failed to fetch user info');
    this.currentUser = await userRes.json();

    // Initialize empty groups array to maintain strict verification
    if (this.currentUser) {
      this.currentUser.groups = [];
    }

    // Fetch Project Details for Ancestry/Sharing
    const projectRes = await fetch(`${host}/api/v4/projects/${encodedProjectPath}`, {
      headers: { 'PRIVATE-TOKEN': pat }
    });
    if (!projectRes.ok) throw new Error('Failed to fetch project details');
    const project = await projectRes.json();

    const ancestors = this.resolveAncestors(project.namespace.full_path);
    const sharedGroups = (project.shared_with_groups || []).map((g: any) => `@${g.group_full_path}`);

    console.log(`[GitLab] Project Namespace: @${project.namespace.full_path}`);
    console.log(`[GitLab] Project Ancestors:`, ancestors);
    console.log(`[GitLab] Shared with groups:`, sharedGroups);

    // 1. Fetch CODEOWNERS first to know which groups are relevant
    const codeownersPaths = [
      'CODEOWNERS',
      '.gitlab/CODEOWNERS',
      'docs/CODEOWNERS'
    ];
    this.codeownersRules = [];
    for (const path of codeownersPaths) {
      const res = await fetch(`${host}/api/v4/projects/${encodedProjectPath}/repository/files/${encodeURIComponent(path)}/raw?ref=${latestVersion.head_commit_sha}`, {
        headers: { 'PRIVATE-TOKEN': pat }
      });
      if (res.ok) {
        const content = await res.text();
        this.codeownersRules = await this.parseCodeowners(content);
        break;
      }
    }

    // 2. Identify relevant project-related groups that appear in CODEOWNERS
    const allRuleOwners = new Set<string>();
    this.codeownersRules.forEach(rule => rule.owners.forEach(o => allRuleOwners.add(o)));

    if (this.currentUser) {
      const projectRelated = [...ancestors, ...sharedGroups, `@${project.namespace.full_path}`];
      
      // Filter for groups that are actually used in CODEOWNERS to identify *candidate* owning groups
      const candidateGroups = projectRelated.filter(grp => allRuleOwners.has(grp));
      
      for (const grp of candidateGroups) {
          // Perform a mandatory STRICT DIRECT membership check for every relevant owning group
          console.log(`[GitLab] Verifying STRICT DIRECT membership for candidate group: ${grp}...`);
          const isDirectMember = await this.checkGroupMembership(host, pat, grp.replace('@', ''), this.currentUser!.id);
          
          if (isDirectMember) {
            console.log(`[GitLab] Direct membership verified for ${grp}. Adding to profile.`);
            if (!this.currentUser!.groups!.includes(grp)) {
                this.currentUser!.groups!.push(grp);
            }
          } else {
            console.log(`[GitLab] User is NOT a direct member of ${grp}. Skipping.`);
          }
      }
    }

    // Fetch Discussions
    const discussions = await this.fetchAll(`${host}/api/v4/projects/${encodedProjectPath}/merge_requests/${mrIid}/discussions`, pat);
    this.remoteComments = [];
    if (discussions) {
      for (const discussion of discussions) {
        for (const note of discussion.notes) {
          if (note.position && note.position.new_line) {
            this.remoteComments.push({
              id: note.id.toString(),
              body: note.body,
              author: note.author?.name || note.author?.username || 'Unknown',
              avatar_url: note.author?.avatar_url,
              discussion_id: discussion.id,
              new_path: note.position.new_path,
              old_path: note.position.old_path,
              new_line: note.position.new_line,
              created_at: note.created_at,
              author_id: note.author?.id,
              resolved: (discussion.notes[0].id === note.id) ? discussion.notes[0].resolved : discussion.resolved || false,
              reactions: note.award_emoji ? this.groupReactions(note.award_emoji) : []
            });
          }
        }
      }
    }

    this.mrData = {
      id: mrInfo.id,
      title: mrInfo.title,
      description: mrInfo.description,
      state: mrInfo.state,
      author: mrInfo.author.name,
      author_username: mrInfo.author.username,
      created_at: mrInfo.created_at,
      web_url: mrInfo.web_url,
      host,
      owner: project.namespace.full_path,
      repo: project.name,
      number: mrIid,
      projectPath,
      headSha: latestVersion.head_commit_sha,
      baseSha: latestVersion.base_commit_sha,
      encodedProjectPath,
      latestVersion,
      projectNamespace: project.namespace.full_path,
      projectAncestors: ancestors,
      sharedWithGroups: sharedGroups,
      draft: mrInfo.draft || mrInfo.work_in_progress
    };
  }

  private resolveAncestors(fullPath: string): string[] {
    const parts = fullPath.split('/');
    const ancestors: string[] = [];
    let current = '';

    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      ancestors.push(`@${current}`);
    }
    return ancestors;
  }

  private async checkGroupMembership(host: string, pat: string, groupPath: string, userId: string | number): Promise<boolean> {
    const cacheKey = `${host}:${userId}:${groupPath}`;
    const now = Date.now();
    
    // Check Cache first
    const cached = this.membershipCache.value[cacheKey];
    if (cached && (now - cached.timestamp < this.CACHE_TTL)) {
      console.log(`[GitLab] Cache HIT for ${groupPath}: ${cached.isMember}`);
      return cached.isMember;
    }

    try {
      const encodedPath = encodeURIComponent(groupPath);
      // Endpoint /members returns only DIRECT members
      const res = await fetch(`${host}/api/v4/groups/${encodedPath}/members?user_ids=${userId}`, {
        headers: { 'PRIVATE-TOKEN': pat }
      });
      
      let isMember = false;
      if (res.ok) {
        const members = await res.json();
        if (members.length > 0) {
            const member = members[0];
            console.log(`[GitLab] Strict Membership Match: Found direct member with access level: ${member.access_level}`);
            isMember = true;
        }
      }

      // Update Cache
      this.membershipCache.value[cacheKey] = {
        isMember,
        timestamp: now
      };
      
      return isMember;
    } catch (e) {
      console.error(`[GitLab] Direct membership check failed for ${groupPath}:`, e);
      return false;
    }
  }

  private groupReactions(awardEmoji: any[]): any[] {
    const grouped: Record<string, { name: string, count: number, users: string[] }> = {};

    awardEmoji.forEach(e => {
      const char = e.name === 'thumbsup' ? '👍' : e.name === 'thumbsdown' ? '👎' : (e.emoji || e.name);
      if (!grouped[char]) {
        grouped[char] = { name: char, count: 0, users: [] };
      }
      grouped[char].count++;
      if (e.user?.name) {
        grouped[char].users.push(e.user.name);
      }
    });

    return Object.values(grouped);
  }

  public async postComment(data: any): Promise<Comment> {
    const pat = await this.getPat();
    const res = await fetch(`${this.mrData!.host}/api/v4/projects/${this.mrData!.encodedProjectPath}/merge_requests/${this.mrData!.number}/discussions`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': pat!, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: data.body,
        position: {
          base_sha: this.mrData!.latestVersion.base_commit_sha,
          head_sha: this.mrData!.latestVersion.head_commit_sha,
          start_sha: this.mrData!.latestVersion.start_commit_sha,
          position_type: 'text',
          new_path: data.new_path,
          old_path: data.old_path,
          new_line: data.new_line,
        }
      })
    });
    if (!res.ok) throw new Error(`Post failed: ${res.statusText}`);
    const discussion = await res.json();
    const note = discussion.notes[0];
    return {
      id: note.id.toString(),
      body: note.body,
      author: note.author?.name || note.author?.username || 'Unknown',
      avatar_url: note.author?.avatar_url,
      discussion_id: discussion.id,
      new_path: note.position.new_path,
      old_path: note.position.old_path,
      new_line: note.position.new_line,
      created_at: note.created_at,
      author_id: note.author?.id,
    };
  }

  public async postReply(baseComment: Comment, body: string): Promise<Comment> {
    const pat = await this.getPat();
    const res = await fetch(`${this.mrData!.host}/api/v4/projects/${this.mrData!.encodedProjectPath}/merge_requests/${this.mrData!.number}/discussions/${baseComment.discussion_id}/notes`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': pat!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });
    if (!res.ok) throw new Error(`Reply failed: ${res.statusText}`);
    const note = await res.json();
    return {
      id: note.id.toString(),
      body: note.body,
      author: note.author?.name || note.author?.username || 'Unknown',
      avatar_url: note.author?.avatar_url,
      discussion_id: baseComment.discussion_id,
      new_path: baseComment.new_path,
      old_path: baseComment.old_path,
      new_line: baseComment.new_line,
      created_at: note.created_at,
      author_id: note.author?.id,
    };
  }

  public async deleteComment(commentId: string): Promise<void> {
    const pat = await this.getPat();
    const res = await fetch(`${this.mrData!.host}/api/v4/projects/${this.mrData!.encodedProjectPath}/merge_requests/${this.mrData!.number}/notes/${commentId}`, {
      method: 'DELETE',
      headers: { 'PRIVATE-TOKEN': pat! }
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.statusText}`);
  }

  public async addReaction(comment: any, emojiName: string): Promise<void> {
    const pat = await this.getPat();
    const res = await fetch(`${this.mrData!.host}/api/v4/projects/${this.mrData!.encodedProjectPath}/merge_requests/${this.mrData!.number}/notes/${comment.id}/award_emoji`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': pat!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: emojiName })
    });
    if (!res.ok) throw new Error('Failed to add reaction');

    // Optimistically update UI
    if (!comment.reactions) comment.reactions = [];
    const char = emojiName === 'thumbsup' ? '👍' : emojiName === 'thumbsdown' ? '👎' : emojiName;
    const existing = comment.reactions.find((r: any) => r.name === char);
    if (existing) {
      existing.count++;
      if (this.currentUser?.name) existing.users.push(this.currentUser.name);
    } else {
      comment.reactions.push({
        name: char,
        count: 1,
        users: this.currentUser?.name ? [this.currentUser.name] : []
      });
    }
  }

  public async editComment(commentId: string, body: string): Promise<void> {
    const pat = await this.getPat();
    const res = await fetch(`${this.mrData!.host}/api/v4/projects/${this.mrData!.encodedProjectPath}/merge_requests/${this.mrData!.number}/notes/${commentId}`, {
      method: 'PUT',
      headers: { 'PRIVATE-TOKEN': pat!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });
    if (!res.ok) throw new Error(`Edit failed: ${res.statusText}`);
  }

  public async getFileContent(path: string, sha: string): Promise<string> {
    const pat = await this.getPat();
    const res = await fetch(`${this.mrData!.host}/api/v4/projects/${this.mrData!.encodedProjectPath}/repository/files/${encodeURIComponent(path)}/raw?ref=${sha}`, {
      headers: { 'PRIVATE-TOKEN': pat! }
    });
    if (!res.ok) {
      if (res.status === 404) return '';
      throw new Error(`Failed to fetch file content: ${res.statusText}`);
    }
    return await res.text();
  }

  public async postFileComment(path: string, body: string): Promise<Comment> {
    const pat = await this.getPat();
    const res = await fetch(`${this.mrData!.host}/api/v4/projects/${this.mrData!.encodedProjectPath}/merge_requests/${this.mrData!.number}/discussions`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': pat!, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body,
        position: {
          base_sha: this.mrData!.latestVersion.base_commit_sha,
          head_sha: this.mrData!.latestVersion.head_commit_sha,
          start_sha: this.mrData!.latestVersion.start_commit_sha,
          position_type: 'text',
          new_path: path,
          old_path: path
        }
      })
    });
    if (!res.ok) throw new Error(`Post file comment failed: ${res.statusText}`);
    const discussion = await res.json();
    const note = discussion.notes[0];
    return {
      id: note.id.toString(),
      body: note.body,
      author: note.author?.name || note.author?.username || 'Unknown',
      avatar_url: note.author?.avatar_url,
      discussion_id: discussion.id,
      new_path: note.position.new_path,
      old_path: note.position.old_path,
      new_line: note.position.new_line,
      created_at: note.created_at,
      author_id: note.author?.id,
      reactions: []
    };
  }

  public async submitReview(comment: string, action: 'approve' | 'request_changes' | 'comment'): Promise<void> {
    const pat = await this.getPat();
    const projectPath = this.mrData!.encodedProjectPath;
    const iid = this.mrData!.number;
    const host = this.mrData!.host;

    const payload: any = {};
    if (comment.trim()) payload.body = comment;

    if (action === 'approve') {
      payload.action = 'approve';
    } else if (action === 'request_changes') {
      payload.action = 'unapprove';
    }

    const res = await fetch(`${host}/api/v4/projects/${projectPath}/merge_requests/${iid}/review`, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': pat!, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error(`Review submission failed: ${res.statusText}`);
    }
  }
  
  public async markAsReady(): Promise<void> {
    const pat = await this.getPat();
    const projectPath = this.mrData!.encodedProjectPath;
    const iid = this.mrData!.number;
    const host = this.mrData!.host;

    const res = await fetch(`${host}/api/v4/projects/${projectPath}/merge_requests/${iid}`, {
      method: 'PUT',
      headers: { 'PRIVATE-TOKEN': pat!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: false })
    });

    if (!res.ok) {
      throw new Error(`Failed to mark as ready: ${res.statusText}`);
    }
    
    if (this.mrData) {
      this.mrData.draft = false;
    }
  }

  public async resolveThread(discussionId: string, resolved: boolean): Promise<void> {
    const pat = await this.getPat();
    const projectPath = this.mrData!.encodedProjectPath;
    const iid = this.mrData!.number;
    const host = this.mrData!.host;

    const res = await fetch(`${host}/api/v4/projects/${projectPath}/merge_requests/${iid}/discussions/${discussionId}`, {
      method: 'PUT',
      headers: { 'PRIVATE-TOKEN': pat!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved })
    });

    if (!res.ok) {
      throw new Error(`Failed to ${resolved ? 'resolve' : 'unresolve'} thread: ${res.statusText}`);
    }

    // Update local state
    this.remoteComments.forEach(c => {
      if (c.discussion_id === discussionId) {
        c.resolved = resolved;
      }
    });
  }

  public async getActiveMRs(): Promise<MRShortMetadata[]> {
    const pat = await this.getPat();
    if (!pat) return [];

    // For now, we default to gitlab.com if no host is configured for the provider.
    // In the future, we'll iterate over all configured GitLab instances.
    const host = 'https://gitlab.com'; 

    try {
      // 1. Fetch current user to get details for filtering (if needed)
      const userRes = await fetch(`${host}/api/v4/user`, {
        headers: { 'PRIVATE-TOKEN': pat }
      });
      if (!userRes.ok) return [];
      const user = await userRes.json();

      // 2. Fetch MRs: Assigned to me, or where I am a reviewer
      // GitLab has specific 'scope' for assigned, but for reviewers we use 'reviewer_id' or 'reviewer_username'
      const assignedMrs = await this.fetchAll(`${host}/api/v4/merge_requests?state=opened&scope=assigned_to_me`, pat);
      const reviewerMrs = await this.fetchAll(`${host}/api/v4/merge_requests?state=opened&scope=all&reviewer_id=${user.id}`, pat);

      const allMrs = [...assignedMrs, ...reviewerMrs];
      
      // 3. De-duplicate (MR could be assigned AND reviewed by the same person)
      const uniqueMrs = Array.from(new Map(allMrs.map(mr => [mr.id, mr])).values());

      return uniqueMrs.map((mr: any) => ({
        id: mr.id,
        projectPath: mr.project_id.toString(), // or full path if available
        title: mr.title,
        url: mr.web_url,
        repository: mr.references?.full || mr.web_url.split('/-/')[0].split('/').slice(-2).join('/'),
        author: mr.author.name,
        updated_at: mr.updated_at,
        platform: 'gitlab',
        draft: mr.work_in_progress || mr.draft
      }));
    } catch (err) {
      console.error('[GitLabProvider] Failed to fetch active MRs:', err);
      return [];
    }
  }

  private async fetchAll(url: string, pat: string): Promise<any[]> {
    let results: any[] = [];
    let page = 1;
    while (true) {
      const separator = url.includes('?') ? '&' : '?';
      const pagedUrl = `${url}${separator}per_page=100&page=${page}`;
      const res: Response = await fetch(pagedUrl, {
        headers: { 'PRIVATE-TOKEN': pat }
      });
      if (!res.ok) throw new Error(`Fetch all failed: ${res.statusText}`);
      const data = await res.json();
      if (!data || data.length === 0) break;
      results = results.concat(data);
      const nextPage = res.headers.get('x-next-page');
      if (!nextPage || nextPage === "") break;
      page = parseInt(nextPage);
    }
    return results;
  }
}
