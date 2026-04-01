import { GitHubProvider } from './GitHubProvider';
import { GitLabProvider } from './GitLabProvider';
import { BaseProvider } from './BaseProvider';
import { Account } from './types';

export * from './types';
export * from './BaseProvider';
export * from './GitHubProvider';
export * from './GitLabProvider';

export interface ParsedUrl {
  platform: 'github' | 'gitlab';
  host: string;
  owner: string;
  repo: string;
  number: string;
  projectPath: string;
}

export function parseUrl(url: string): ParsedUrl {
  const urlObj = new URL(url);
  const host = urlObj.origin;

  // GitHub: /{owner}/{repo}/pull/{number}
  const ghMatch = urlObj.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (ghMatch) {
    return {
      platform: 'github',
      host,
      owner: ghMatch[1],
      repo: ghMatch[2],
      number: ghMatch[3],
      projectPath: `${ghMatch[1]}/${ghMatch[2]}`,
    };
  }

  // GitLab: /{project_path}/-/merge_requests/{iid}
  const glMatch = urlObj.pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)/);
  if (glMatch) {
    return {
      platform: 'gitlab',
      host,
      owner: '',
      repo: '',
      number: glMatch[2],
      projectPath: glMatch[1],
    };
  }

  throw new Error('Invalid URL format. Supported:\n• GitLab: https://gitlab.com/org/project/-/merge_requests/42\n• GitHub: https://github.com/owner/repo/pull/123');
}

export function createProvider(url: string, accounts: Account[]): BaseProvider {
  const parsed = parseUrl(url);
  
  // Find an account that matches the host
  const account = accounts.find(a => {
    try {
      const aHost = new URL(a.host).origin;
      const uHost = new URL(parsed.host).origin;
      return aHost === uHost && a.platform === parsed.platform;
    } catch {
      return false;
    }
  });

  if (!account) {
    throw new Error(`No account found for ${parsed.host}. Please add it in Settings.`);
  }

  if (parsed.platform === 'github') {
    return new GitHubProvider(account);
  } else {
    return new GitLabProvider(account);
  }
}
