import { BaseProvider } from './BaseProvider';
import { Comment, DiffFile, MRMetadata, CodeownerRule, User, MRShortMetadata, Account } from './types';

export class GitHubProvider extends BaseProvider {
  public platform: 'github' = 'github' as const;
  public mrData: MRMetadata | null = null;
  public diffs: DiffFile[] = [];
  public currentUser: User | null = null;
  public codeownersRules: CodeownerRule[] = [];
  public remoteComments: Comment[] = [];

  constructor(account?: Account) {
    super(account);
  }

  public async initialize(parsed: { owner: string; repo: string; number: string; projectPath: string; host: string }): Promise<void> {
    const pat = await this.getPat();
    if (!pat) throw new Error('No GitHub PAT found. Go to Settings.');

    const { owner, repo, number: prNumber, projectPath, host } = parsed;
    // Normalize GitHub host: github.com -> api.github.com
    let apiBase = host || 'https://api.github.com';
    if (apiBase.includes('github.com') && !apiBase.includes('api.github.com')) {
      apiBase = 'https://api.github.com';
    }

    const headers: HeadersInit = {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github.squirrel-girl-preview+json',
    };

    // Set initial MR metadata skeleton
    this.mrData = { host: apiBase, owner, repo, number: prNumber, projectPath } as any;

    // Fetch PR Info
    const infoRes = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
    if (!infoRes.ok) throw new Error(`Failed to fetch PR info: ${infoRes.statusText}`);
    const prData = await infoRes.json();

    // Fetch PR Files (Diffs)
    const ghFiles = await this.fetchAll(`${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`, headers);

    this.diffs = ghFiles.map((f: any) => ({
      new_path: f.filename,
      old_path: f.previous_filename || f.filename,
      diff: f.patch || '',
      new_file: f.status === 'added',
      deleted_file: f.status === 'removed',
      renamed_file: f.status === 'renamed',
      sha: f.sha
    }));

    // Fetch User
    const userRes = await fetch(`${apiBase}/user`, { headers });
    if (!userRes.ok) throw new Error('Failed to fetch user info');
    const userData = await userRes.json();
    this.currentUser = { 
        id: userData.id,
        username: userData.login,
        name: userData.name,
        avatar_url: userData.avatar_url
    };
    
    // Fetch User Teams
    const teamsRes = await fetch(`${apiBase}/user/teams`, { headers });
    if (teamsRes.ok) {
        const teams = await teamsRes.json();
        this.currentUser.groups = teams.map((t: any) => `@${t.organization.login}/${t.slug}`);
    }

    // Fetch CODEOWNERS via API
    const codeownersPaths = [
      'CODEOWNERS',
      '.github/CODEOWNERS',
      'docs/CODEOWNERS'
    ];
    this.codeownersRules = [];
    for (const path of codeownersPaths) {
      const res = await fetch(`${apiBase}/repos/${owner}/${repo}/contents/${path}?ref=${prData.head.sha}`, {
        headers: { 
          ...headers,
          'Accept': 'application/vnd.github.v3.raw'
        }
      });
      if (res.ok) {
        const content = await res.text();
        this.codeownersRules = await this.parseCodeowners(content);
        break;
      }
    }

    // Fetch Metadata and Comments
    const [metadata, comments] = await Promise.all([
      this.getMRMetadata(),
      this.getComments()
    ]);

    this.mrData = {
        ...this.mrData,
        ...metadata
    } as MRMetadata;
    this.remoteComments = comments;
  }

  public async getComments(): Promise<Comment[]> {
    const pat = await this.getPat();
    if (!this.mrData || !pat) return [];
    
    const headers: HeadersInit = {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github.squirrel-girl-preview+json',
    };

    const ghComments = await this.fetchAll(`${this.mrData.host}/repos/${this.mrData.owner}/${this.mrData.repo}/pulls/${this.mrData.number}/comments?per_page=100`, headers);
    const comments: Comment[] = [];
    if (ghComments) {
      for (const c of ghComments) {
        if (c.path && c.line) {
          comments.push({
            id: c.id.toString(),
            body: c.body,
            author: c.user?.login || 'Unknown',
            avatar_url: c.user?.avatar_url,
            in_reply_to_id: c.in_reply_to_id?.toString(),
            new_path: c.path,
            old_path: c.path,
            new_line: c.line,
            created_at: c.created_at,
            author_id: c.user?.id,
            reactions: c.reactions ? [
              { name: '👍', count: c.reactions['+1'] || 0 },
              { name: '👎', count: c.reactions['-1'] || 0 },
              { name: '😄', count: c.reactions['laugh'] || 0 },
              { name: '🎉', count: c.reactions['hooray'] || 0 },
              { name: '❤️', count: c.reactions['heart'] || 0 },
              { name: '🚀', count: c.reactions['rocket'] || 0 },
              { name: '👀', count: c.reactions['eyes'] || 0 },
              { name: '😕', count: c.reactions['confused'] || 0 },
            ].filter(r => r.count > 0) : []
          });
        }
      }
    }
    return comments;
  }

  public async getMRMetadata(): Promise<Partial<MRMetadata>> {
    const pat = await this.getPat();
    if (!this.mrData || !pat) return {};

    const headers: HeadersInit = {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github.v3+json',
    };

    // Standard GitHub API URL should always be api.github.com
    let host = this.mrData.host;
    if (host.includes('github.com') && !host.includes('api.github.com')) {
        host = 'https://api.github.com';
    }

    const res = await fetch(`${host}/repos/${this.mrData.owner}/${this.mrData.repo}/pulls/${this.mrData.number}`, { headers });
    if (!res.ok) throw new Error(`Failed to fetch PR metadata: ${res.statusText}`);
    const prData = await res.json();

    return {
      id: prData.id,
      title: prData.title,
      description: prData.body,
      state: prData.state,
      author: prData.user.login,
      author_username: prData.user.login,
      created_at: prData.created_at,
      web_url: prData.html_url,
      host: this.mrData.host,
      owner: this.mrData.owner,
      repo: this.mrData.repo,
      number: this.mrData.number,
      projectPath: this.mrData.projectPath,
      draft: prData.draft,
      labels: prData.labels?.map((l: any) => l.name) || [],
      assignees: prData.assignees?.map((a: any) => a.login) || [],
      milestone: prData.milestone?.title,
      source_branch: prData.head.ref,
      target_branch: prData.base.ref,
      headSha: prData.head.sha,
      baseSha: prData.base.sha,
      updated_at: prData.updated_at
    };
  }

  public async postComment(data: any): Promise<Comment> {
    const pat = await this.getPat();
    const headers = { 
        'Authorization': `Bearer ${pat}`, 
        'Accept': 'application/vnd.github.squirrel-girl-preview+json',
        'Content-Type': 'application/json' 
    };

    const res = await fetch(`https://api.github.com/repos/${this.mrData!.owner}/${this.mrData!.repo}/pulls/${this.mrData!.number}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        body: data.body,
        commit_id: this.mrData!.headSha,
        path: data.new_path,
        line: data.new_line,
        side: 'RIGHT'
      })
    });
    if (!res.ok) throw new Error(`Post failed: ${res.statusText}`);
    const newNote = await res.json();
    return {
        id: newNote.id.toString(),
        body: newNote.body,
        author: newNote.user?.login || 'Unknown',
        avatar_url: newNote.user?.avatar_url,
        new_path: newNote.path,
        old_path: newNote.path,
        new_line: newNote.line,
        created_at: newNote.created_at,
        author_id: newNote.user?.id,
    };
  }

  public async postReply(baseComment: Comment, body: string): Promise<Comment> {
    const pat = await this.getPat();
    const headers = { 
        'Authorization': `Bearer ${pat}`, 
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json' 
    };

    const res = await fetch(`https://api.github.com/repos/${this.mrData!.owner}/${this.mrData!.repo}/pulls/${this.mrData!.number}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        body,
        in_reply_to_id: parseInt(baseComment.id)
      })
    });
    if (!res.ok) throw new Error(`Reply failed: ${res.statusText}`);
    const newNote = await res.json();
    return {
        id: newNote.id.toString(),
        body: newNote.body,
        author: newNote.user?.login || 'Unknown',
        avatar_url: newNote.user?.avatar_url,
        in_reply_to_id: baseComment.id,
        new_path: baseComment.new_path,
        old_path: baseComment.old_path,
        new_line: baseComment.new_line,
        created_at: newNote.created_at,
        author_id: newNote.user?.id,
    };
  }

  public async deleteComment(commentId: string): Promise<void> {
    const pat = await this.getPat();
    const res = await fetch(`https://api.github.com/repos/${this.mrData!.owner}/${this.mrData!.repo}/pulls/comments/${commentId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${pat}` }
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.statusText}`);
  }

  public async addReaction(comment: any, emojiName: string): Promise<void> {
    const pat = await this.getPat();
    const res = await fetch(`https://api.github.com/repos/${this.mrData!.owner}/${this.mrData!.repo}/pulls/comments/${comment.id}/reactions`, {
      method: 'POST',
      headers: { 
          'Authorization': `Bearer ${pat}`, 
          'Accept': 'application/vnd.github.squirrel-girl-preview+json',
          'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ content: emojiName })
    });
    if (!res.ok) throw new Error('Failed to add reaction');
  }

  public async editComment(commentId: string, body: string): Promise<void> {
    const pat = await this.getPat();
    const res = await fetch(`https://api.github.com/repos/${this.mrData!.owner}/${this.mrData!.repo}/pulls/comments/${commentId}`, {
      method: 'PATCH',
      headers: { 
          'Authorization': `Bearer ${pat}`, 
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ body })
    });
    if (!res.ok) throw new Error(`Edit failed: ${res.statusText}`);
  }

  public async getFileContent(path: string, sha: string): Promise<string> {
    const pat = await this.getPat();
    const res = await fetch(`https://api.github.com/repos/${this.mrData!.owner}/${this.mrData!.repo}/contents/${path}?ref=${sha}`, {
      headers: { 
          'Authorization': `Bearer ${pat}`,
          'Accept': 'application/vnd.github.v3.raw'
      }
    });
    if (!res.ok) {
        if (res.status === 404) return '';
        throw new Error(`Failed to fetch file content: ${res.statusText}`);
    }
    return await res.text();
  }

  public async postFileComment(path: string, body: string): Promise<Comment> {
    const pat = await this.getPat();
    const headers = { 
        'Authorization': `Bearer ${pat}`, 
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json' 
    };

    const res = await fetch(`https://api.github.com/repos/${this.mrData!.owner}/${this.mrData!.repo}/pulls/${this.mrData!.number}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        body,
        commit_id: this.mrData!.headSha,
        path,
        subject_type: 'file'
      })
    });
    if (!res.ok) throw new Error(`Post file comment failed: ${res.statusText}`);
    const newNote = await res.json();
    return {
        id: newNote.id.toString(),
        body: newNote.body,
        author: newNote.user?.login || 'Unknown',
        avatar_url: newNote.user?.avatar_url,
        new_path: newNote.path,
        old_path: newNote.path,
        new_line: newNote.line,
        created_at: newNote.created_at,
        author_id: newNote.user?.id,
    };
  }

  public async submitReview(comment: string, action: 'approve' | 'request_changes' | 'comment', comments: any[] = []): Promise<void> {
    const pat = await this.getPat();
    const event = action === 'approve' ? 'APPROVE' : action === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT';
    
    // Separate line comments from file-level comments as GitHub's reviews API
    // primarily handles line-based comments in the atomic bundle.
    const lineComments = comments.filter(c => !c.is_file_level).map(c => ({
      path: c.new_path,
      line: c.new_line,
      body: c.body,
      side: 'RIGHT'
    }));

    const fileComments = comments.filter(c => c.is_file_level);

    // 1. Post file-level comments separately if any
    for (const fc of fileComments) {
      await this.postFileComment(fc.new_path, fc.body);
    }

    // 2. Submit the review with line comments
    const res = await fetch(`https://api.github.com/repos/${this.mrData!.owner}/${this.mrData!.repo}/pulls/${this.mrData!.number}/reviews`, {
      method: 'POST',
      headers: { 
          'Authorization': `Bearer ${pat}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json' 
      },
      body: JSON.stringify({
        body: comment,
        event,
        comments: lineComments.length > 0 ? lineComments : undefined
      })
    });
    if (!res.ok) throw new Error(`Review submission failed: ${res.statusText}`);
  }

  public async markAsReady(): Promise<void> {
    const pat = await this.getPat();
    const headers = { 
        'Authorization': `Bearer ${pat}`, 
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json' 
    };

    const res = await fetch(`https://api.github.com/repos/${this.mrData!.owner}/${this.mrData!.repo}/pulls/${this.mrData!.number}/ready`, {
      method: 'POST',
      headers
    });

    if (res.ok) {
      if (this.mrData) {
        this.mrData.draft = false;
      }
    } else {
      throw new Error(`Failed to mark as ready: ${res.statusText}`);
    }
  }

  public async getActiveMRs(): Promise<MRShortMetadata[]> {
    const pat = await this.getPat();
    if (!pat) return [];

    const apiBase = 'https://api.github.com';
    const headers: HeadersInit = {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github.v3+json',
    };

    try {
      // Use Search API to fetch PRs where user is involved (author, assignee, or reviewer)
      // q=is:pr+is:open+archived:false+(assignee:@me+OR+author:@me+OR+reviewer-requested:@me)
      const query = encodeURIComponent('is:pr is:open archived:false (assignee:@me author:@me reviewer-requested:@me)');
      const res = await fetch(`${apiBase}/search/issues?q=${query}`, { headers });
      
      if (!res.ok) {
        console.error('[GitHubProvider] Search API failed:', res.statusText);
        return [];
      }

      const data = await res.json();
      const items = data.items || [];

      return items.map((pr: any) => {
        // GitHub Search API returns issue-like objects. repository_url is like "https://api.github.com/repos/owner/repo"
        const repoFullName = pr.repository_url.split('/repos/')[1];
        
        return {
          id: pr.id,
          projectPath: repoFullName,
          title: pr.title,
          url: pr.html_url,
          repository: repoFullName,
          author: pr.user.login,
          updated_at: pr.updated_at,
          platform: 'github',
          draft: pr.draft
        };
      });
    } catch (err) {
      console.error('[GitHubProvider] Failed to fetch active MRs:', err);
      return [];
    }
  }

  public async resolveThread(_discussionId: string, _resolved: boolean): Promise<void> {
    // REST API does not support resolving threads. 
    // This would require GraphQL implementation.
    console.warn('Resolving threads is not supported on GitHub REST API.');
  }

  private async fetchAll(url: string, headers: HeadersInit): Promise<any[]> {
    let results: any[] = [];
    let nextUrl: string | null = url;
    while (nextUrl) {
      const res: Response = await fetch(nextUrl, { headers });
      if (!res.ok) throw new Error(`Fetch all failed: ${res.statusText}`);
      const data = await res.json();
      results = results.concat(data);
      const link: string | null = res.headers.get('Link');
      if (link) {
        const match: RegExpMatchArray | null = link.match(/<([^>]+)>; rel="next"/);
        nextUrl = match ? match[1] : null;
      } else {
        nextUrl = null;
      }
    }
    return results;
  }
}
