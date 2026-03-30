import { Comment, DiffFile, MRMetadata, CodeownerRule, Platform, User } from './types';

export abstract class BaseProvider {
  public abstract platform: Platform;
  public abstract mrData: MRMetadata | null;
  public abstract diffs: DiffFile[];
  public abstract currentUser: User | null;
  public abstract codeownersRules: CodeownerRule[];
  public abstract remoteComments: Comment[];

  protected abstract patLabel: string;

  /**
   * Helper to fetch personal access token with secure storage fallback
   */
  public async getPat(): Promise<string | null> {
    const key = this.patLabel;
    const res = await (window as any).electronAPI.getSecret(key);
    if (res.success && res.value) return res.value;
    
    const fallback = localStorage.getItem(key);
    if (fallback) {
      console.warn(`[Storage] Falling back to localStorage for ${key}.`);
    }
    return fallback;
  }

  /**
   * Universal CODEOWNERS parser using 'codeowners-utils' (via IPC)
   */
  public async parseCodeowners(content: string): Promise<CodeownerRule[]> {
    return await window.electronAPI.parseCodeowners(content);
  }

  // --- Abstract API Methods ---

  public abstract initialize(urlProps: any): Promise<void>;
  
  public abstract postComment(data: any): Promise<Comment>;
  
  public abstract postReply(baseComment: Comment, body: string): Promise<Comment>;
  
  public abstract deleteComment(commentId: string): Promise<void>;
  
  public abstract addReaction(comment: any, emojiName: string): Promise<void>;

  public abstract editComment(commentId: string, body: string): Promise<void>;

  public abstract getFileContent(path: string, sha: string): Promise<string>;
}
