import { BaseProvider } from './BaseProvider';
import { Comment, DiffFile, MRMetadata, CodeownerRule, User } from './types';

export class GitLabProvider extends BaseProvider {
  public platform: 'gitlab' = 'gitlab' as const;
  public mrData: MRMetadata | null = null;
  public diffs: DiffFile[] = [];
  public currentUser: User | null = null;
  public codeownersRules: CodeownerRule[] = [];
  public remoteComments: Comment[] = [];

  protected patLabel = 'gitlab_pat';

  public async initialize(parsed: { host: string; projectPath: string; number: string }): Promise<void> {
    const pat = await this.getPat();
    if (!pat) throw new Error('No GitLab PAT found. Go to Settings.');

    const { host, projectPath, number: mrIid } = parsed;
    const encodedProjectPath = encodeURIComponent(projectPath);

    // Clone/Fetch repository
    const appData = await (window as any).electronAPI.getAppPath();
    const targetPath = `${appData}/review-master-repos/${projectPath}`;
    const cloneUrl = `${host}/${projectPath}.git`.replace('https://', `https://oauth2:${pat}@`);

    const cloneRes = await (window as any).electronAPI.cloneRepo(cloneUrl, targetPath);
    if (!cloneRes.success) throw new Error(`Clone failed: ${cloneRes.error}`);

    // Fetch Diffs
    const diffsRes = await fetch(`${host}/api/v4/projects/${encodedProjectPath}/merge_requests/${mrIid}/diffs`, {
      headers: { 'PRIVATE-TOKEN': pat }
    });
    if (!diffsRes.ok) throw new Error(`Failed to fetch diffs: ${diffsRes.statusText}`);
    this.diffs = await diffsRes.json();

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

    // Fetch CODEOWNERS
    const codeownersPaths = [
      `${targetPath}/CODEOWNERS`,
      `${targetPath}/.gitlab/CODEOWNERS`,
      `${targetPath}/docs/CODEOWNERS`
    ];
    this.codeownersRules = [];
    for (const path of codeownersPaths) {
      const res = await (window as any).electronAPI.readFile(path);
      if (res.success && res.content) {
        this.codeownersRules = this.parseCodeowners(res.content);
        break;
      }
    }

    // Fetch Discussions
    const discussionsRes = await fetch(`${host}/api/v4/projects/${encodedProjectPath}/merge_requests/${mrIid}/discussions`, {
      headers: { 'PRIVATE-TOKEN': pat }
    });
    this.remoteComments = [];
    if (discussionsRes.ok) {
      const discussions = await discussionsRes.json();
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
              reactions: note.award_emoji ? this.groupReactions(note.award_emoji) : []
            });
          }
        }
      }
    }

    this.mrData = {
      title: mrInfo.title,
      host,
      owner: '',
      repo: '',
      number: mrIid,
      projectPath,
      headSha: latestVersion.head_commit_sha,
      baseSha: latestVersion.base_commit_sha,
      encodedProjectPath,
      latestVersion,
    };
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
}
