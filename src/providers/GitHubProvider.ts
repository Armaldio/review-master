import { BaseProvider } from './BaseProvider';
import { Comment, DiffFile, MRMetadata, CodeownerRule, User } from './types';

export class GitHubProvider extends BaseProvider {
  public platform: 'github' = 'github' as const;
  public mrData: MRMetadata | null = null;
  public diffs: DiffFile[] = [];
  public currentUser: User | null = null;
  public codeownersRules: CodeownerRule[] = [];
  public remoteComments: Comment[] = [];

  protected patLabel = 'github_pat';

  public async initialize(parsed: { owner: string; repo: string; number: string; projectPath: string; host: string }): Promise<void> {
    const pat = await this.getPat();
    if (!pat) throw new Error('No GitHub PAT found. Go to Settings.');

    const { owner, repo, number: prNumber, projectPath, host } = parsed;
    const apiBase = 'https://api.github.com';
    const headers: HeadersInit = {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github.squirrel-girl-preview+json',
    };

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

    // Fetch Comments
    const ghComments = await this.fetchAll(`${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`, headers);
    this.remoteComments = [];
    if (ghComments) {
      for (const c of ghComments) {
        if (c.path && c.line) {
          this.remoteComments.push({
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

    this.mrData = {
      title: prData.title,
      host: apiBase,
      owner,
      repo,
      number: prNumber,
      projectPath,
      headSha: prData.head.sha,
      baseSha: prData.base.sha,
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
