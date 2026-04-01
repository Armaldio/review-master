export type Platform = 'github' | 'gitlab';

export interface User {
  id: string | number;
  username: string;
  name?: string;
  avatar_url?: string;
  groups?: string[];
}

export interface Reaction {
  name: string;
  count: number;
  me?: boolean;
  users?: string[];
}

export interface Comment {
  id: string;
  body: string;
  author: string;
  author_id: string | number;
  avatar_url?: string;
  created_at: string;
  new_path: string;
  old_path: string;
  new_line: number;
  in_reply_to_id?: string;
  discussion_id?: string;
  resolved?: boolean;
  reactions?: Reaction[];
  is_batched?: boolean;
  range?: any; // SelectedLineRange
}

export interface DiffFile {
  new_path: string;
  old_path: string;
  diff: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
  sha: string;
}

export interface MRMetadata {
  title: string;
  host: string;
  owner: string;
  repo: string;
  number: string;
  projectPath: string;
  headSha: string;
  baseSha: string;
  id: string | number;
  description?: string;
  state?: string;
  author?: string;
  author_username?: string;
  created_at?: string;
  web_url?: string;
  encodedProjectPath?: string;
  latestVersion?: any;
  projectNamespace?: string;
  projectAncestors?: string[];
  sharedWithGroups?: string[];
  draft?: boolean;
  labels?: string[];
  assignees?: string[];
  milestone?: string;
  source_branch?: string;
  target_branch?: string;
  updated_at: string;
}

export interface CodeownerRule {
  pattern: string;
  owners: string[];
}

export interface MRShortMetadata {
  id: string | number;
  projectPath: string;
  title: string;
  url: string;
  repository: string;
  author: string;
  updated_at: string;
  platform: Platform;
  draft?: boolean;
}

export interface Account {
  id: string;
  platform: Platform;
  host: string;
  tokenKey: string;
  username: string;
  avatar_url?: string;
  name?: string;
  lastTestedAt?: string;
}
