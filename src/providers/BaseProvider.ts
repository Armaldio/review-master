import { Comment, DiffFile, MRMetadata, CodeownerRule, Platform, User, MRShortMetadata, Account } from './types';

export abstract class BaseProvider {
  public abstract platform: Platform;
  public abstract mrData: MRMetadata | null;
  public abstract diffs: DiffFile[];
  public abstract currentUser: User | null;
  public abstract codeownersRules: CodeownerRule[];
  public abstract remoteComments: Comment[];

  protected tokenKey: string = '';
  protected host: string = '';

  constructor(account?: Account) {
    if (account) {
      this.tokenKey = account.tokenKey;
      this.host = account.host;
    }
  }

  /**
   * Helper to fetch personal access token with secure storage fallback
   */
  public async getPat(): Promise<string | null> {
    const key = this.tokenKey;
    if (!key) {
      console.warn('[BaseProvider] No tokenKey defined for this account.');
      return null;
    }
    
    const token = localStorage.getItem(key);
    if (!token) {
      console.error(`[BaseProvider] No token found for ${key} in localStorage.`);
      return null;
    }
    
    return token;
  }

  /**
   * Universal CODEOWNERS parser using 'codeowners-utils' (via IPC)
   */
  public async parseCodeowners(content: string): Promise<CodeownerRule[]> {
    return await window.electronAPI.parseCodeowners(content);
  }

  // --- Abstract API Methods ---

  public abstract initialize(urlProps: any): Promise<void>;
  
  public abstract getComments(): Promise<Comment[]>;
  
  public abstract getMRMetadata(): Promise<Partial<MRMetadata>>;

  public abstract postComment(data: any): Promise<Comment>;
  
  public abstract postReply(baseComment: Comment, body: string): Promise<Comment>;
  
  public abstract deleteComment(commentId: string): Promise<void>;
  
  public abstract addReaction(comment: any, emojiName: string): Promise<void>;

  public abstract editComment(commentId: string, body: string): Promise<void>;

  public abstract getFileContent(path: string, sha: string): Promise<string>;

  public abstract postFileComment(path: string, body: string): Promise<Comment>;
  
  public abstract submitReview(comment: string, action: 'approve' | 'request_changes' | 'comment', comments?: any[]): Promise<void>;

  public abstract markAsReady(): Promise<void>;
  
  public abstract resolveThread(discussionId: string, resolved: boolean): Promise<void>;

  public abstract getActiveMRs(): Promise<MRShortMetadata[]>;
}
