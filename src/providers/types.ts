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
  // Specific to GitLab
  encodedProjectPath?: string;
  latestVersion?: any;
}

export interface CodeownerRule {
  pattern: string;
  owners: string[];
}
