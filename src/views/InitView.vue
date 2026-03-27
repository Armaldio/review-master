<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useReviewStore } from '../store';

const router = useRouter();
const reviewStore = useReviewStore();
const mrUrl = ref('');
const loading = ref(false);
const errorMsg = ref('');
const recentMrs = ref<Array<{ url: string, title: string, project: string }>>([]);

onMounted(() => {
  const hasAnyToken = localStorage.getItem('gitlab_pat') || localStorage.getItem('github_pat');
  if (!hasAnyToken) {
    router.push('/settings');
  }
  loadHistory();
});

const loadHistory = () => {
  const history = localStorage.getItem('mr_history');
  if (history) {
    recentMrs.value = JSON.parse(history);
  }
};

const saveToHistory = (url: string, title: string, project: string) => {
  let history = recentMrs.value.filter(item => item.url !== url);
  history.unshift({ url, title, project });
  history = history.slice(0, 5);
  recentMrs.value = history;
  localStorage.setItem('mr_history', JSON.stringify(history));
};

const loadFromHistory = (url: string) => {
  mrUrl.value = url;
  initializeReview();
};

// --- Platform detection ---

type Platform = 'gitlab' | 'github';

interface ParsedUrl {
  platform: Platform;
  host: string;
  owner: string;
  repo: string;
  number: string;  // MR iid or PR number
  projectPath: string;  // "owner/repo" for both
}

const parseUrl = (url: string): ParsedUrl => {
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
};

// --- GitLab flow ---

const initGitLab = async (parsed: ParsedUrl) => {
  const pat = localStorage.getItem('gitlab_pat');
  if (!pat) throw new Error('No GitLab PAT found. Go to Settings.');

  const { host, projectPath, number: mrIid } = parsed;
  const encodedProjectPath = encodeURIComponent(projectPath);

  // Clone/Fetch
  const appData = await window.electronAPI.getAppPath();
  const targetPath = `${appData}/review-master-repos/${projectPath}`;
  const cloneUrl = `${host}/${projectPath}.git`.replace('https://', `https://oauth2:${pat}@`);

  const cloneRes = await window.electronAPI.cloneRepo(cloneUrl, targetPath);
  if (!cloneRes.success) throw new Error(`Clone failed: ${cloneRes.error}`);

  // Fetch diffs
  const diffsRes = await fetch(`${host}/api/v4/projects/${encodedProjectPath}/merge_requests/${mrIid}/diffs`, {
    headers: { 'PRIVATE-TOKEN': pat }
  });
  if (!diffsRes.ok) throw new Error(`Failed to fetch diffs: ${diffsRes.statusText}`);
  const diffs = await diffsRes.json();

  // Fetch MR info
  const infoRes = await fetch(`${host}/api/v4/projects/${encodedProjectPath}/merge_requests/${mrIid}`, {
    headers: { 'PRIVATE-TOKEN': pat }
  });
  const mrData = await infoRes.json();

  // Fetch versions
  const versionsRes = await fetch(`${host}/api/v4/projects/${encodedProjectPath}/merge_requests/${mrIid}/versions`, {
    headers: { 'PRIVATE-TOKEN': pat }
  });
  const versions = await versionsRes.json();
  const latestVersion = versions[0];

  // Fetch user
  const userRes = await fetch(`${host}/api/v4/user`, {
    headers: { 'PRIVATE-TOKEN': pat }
  });
  if (!userRes.ok) throw new Error('Failed to fetch user info');
  const userData = await userRes.json();

  // CODEOWNERS
  const codeownersPaths = [
    `${targetPath}/CODEOWNERS`,
    `${targetPath}/.gitlab/CODEOWNERS`,
    `${targetPath}/docs/CODEOWNERS`
  ];
  let rules: Array<{ pattern: string, owners: string[] }> = [];
  for (const path of codeownersPaths) {
    const res = await window.electronAPI.readFile(path);
    if (res.success && res.content) {
      rules = parseCodeowners(res.content);
      break;
    }
  }

  // Fetch existing discussions/comments
  const discussionsRes = await fetch(`${host}/api/v4/projects/${encodedProjectPath}/merge_requests/${mrIid}/discussions`, {
    headers: { 'PRIVATE-TOKEN': pat }
  });
  let remoteComments: any[] = [];
  if (discussionsRes.ok) {
    const discussions = await discussionsRes.json();
    for (const discussion of discussions) {
      for (const note of discussion.notes) {
        if (note.position && note.position.new_line) {
          remoteComments.push({
            id: note.id.toString(),
            body: note.body,
            author: note.author?.name || note.author?.username || 'Unknown',
            new_path: note.position.new_path,
            old_path: note.position.old_path,
            new_line: note.position.new_line,
            created_at: note.created_at,
          });
        }
      }
    }
  }

  saveToHistory(mrUrl.value, mrData.title, projectPath);

  reviewStore.platform = 'gitlab';
  reviewStore.mrData = { ...mrData, latestVersion, host, encodedProjectPath, mrIid };
  reviewStore.diffs = diffs;
  reviewStore.currentUser = userData;
  reviewStore.codeownersRules = rules;
  reviewStore.remoteComments = remoteComments;

  if (diffs.length > 0) {
    reviewStore.selectFile(diffs[0].new_path);
  }
};

// --- GitHub flow ---

const initGitHub = async (parsed: ParsedUrl) => {
  const pat = localStorage.getItem('github_pat');
  if (!pat) throw new Error('No GitHub PAT found. Go to Settings.');

  const { owner, repo, number: prNumber, projectPath } = parsed;
  const apiBase = 'https://api.github.com';
  const headers: HeadersInit = {
    'Authorization': `Bearer ${pat}`,
    'Accept': 'application/vnd.github.v3+json',
  };

  // Clone/Fetch
  const appData = await window.electronAPI.getAppPath();
  const targetPath = `${appData}/review-master-repos/${projectPath}`;
  const cloneUrl = `https://x-access-token:${pat}@github.com/${projectPath}.git`;

  const cloneRes = await window.electronAPI.cloneRepo(cloneUrl, targetPath);
  if (!cloneRes.success) throw new Error(`Clone failed: ${cloneRes.error}`);

  // Fetch PR info
  const infoRes = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
  if (!infoRes.ok) throw new Error(`Failed to fetch PR info: ${infoRes.statusText}`);
  const prData = await infoRes.json();

  // Fetch PR files (diffs)
  const filesRes = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=300`, { headers });
  if (!filesRes.ok) throw new Error(`Failed to fetch PR files: ${filesRes.statusText}`);
  const ghFiles = await filesRes.json();

  // Normalize GitHub files to match GitLab diff format
  const diffs = ghFiles.map((f: any) => ({
    new_path: f.filename,
    old_path: f.previous_filename || f.filename,
    diff: f.patch || '',
    new_file: f.status === 'added',
    deleted_file: f.status === 'removed',
    renamed_file: f.status === 'renamed',
  }));

  // Fetch user
  const userRes = await fetch(`${apiBase}/user`, { headers });
  if (!userRes.ok) throw new Error('Failed to fetch user info');
  const userData = await userRes.json();

  // CODEOWNERS
  const codeownersPaths = [
    `${targetPath}/CODEOWNERS`,
    `${targetPath}/.github/CODEOWNERS`,
    `${targetPath}/docs/CODEOWNERS`
  ];
  let rules: Array<{ pattern: string, owners: string[] }> = [];
  for (const path of codeownersPaths) {
    const res = await window.electronAPI.readFile(path);
    if (res.success && res.content) {
      rules = parseCodeowners(res.content);
      break;
    }
  }
  // Fetch existing review comments
  const commentsRes = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=300`, { headers });
  let remoteComments: any[] = [];
  if (commentsRes.ok) {
    const ghComments = await commentsRes.json();
    for (const c of ghComments) {
      if (c.path && c.line) {
        remoteComments.push({
          id: c.id.toString(),
          body: c.body,
          author: c.user?.login || 'Unknown',
          new_path: c.path,
          old_path: c.path,
          new_line: c.line,
          created_at: c.created_at,
        });
      }
    }
  }

  saveToHistory(mrUrl.value, prData.title, projectPath);

  reviewStore.platform = 'github';
  reviewStore.mrData = {
    title: prData.title,
    host: 'https://api.github.com',
    owner,
    repo,
    prNumber,
    headSha: prData.head.sha,
    baseSha: prData.base.sha,
  };
  reviewStore.diffs = diffs;
  reviewStore.currentUser = { username: userData.login, ...userData };
  reviewStore.codeownersRules = rules;
  reviewStore.remoteComments = remoteComments;

  if (diffs.length > 0) {
    reviewStore.selectFile(diffs[0].new_path);
  }
};

// --- Main entry ---

const initializeReview = async () => {
  loading.value = true;
  errorMsg.value = '';

  try {
    const parsed = parseUrl(mrUrl.value);

    if (parsed.platform === 'github') {
      await initGitHub(parsed);
    } else {
      await initGitLab(parsed);
    }

    router.push('/review');
  } catch (err) {
    errorMsg.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
};

const parseCodeowners = (content: string) => {
  const lines = content.split('\n');
  const rules: Array<{ pattern: string, owners: string[] }> = [];

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      const pattern = parts[0];
      const owners = parts.slice(1);
      rules.push({ pattern, owners });
    }
  }
  return rules;
};
</script>

<template>
  <div class="init-container">
    <h2>Initialize Review</h2>
    <div class="form-group">
      <label for="mrUrl">Merge Request / Pull Request URL</label>
      <input id="mrUrl" v-model="mrUrl" type="text" placeholder="https://gitlab.com/org/project/-/merge_requests/1 or https://github.com/owner/repo/pull/123" />
    </div>
    <button @click="initializeReview" :disabled="loading">
      {{ loading ? 'Loading...' : 'Start Review' }}
    </button>
    
    <div v-if="errorMsg" class="error">{{ errorMsg }}</div>

    <div v-if="recentMrs.length > 0" class="history-section">
      <h3>Recent Reviews</h3>
      <ul class="history-list">
        <li v-for="item in recentMrs" :key="item.url" @click="loadFromHistory(item.url)" class="history-item">
          <div class="m-title">{{ item.title }}</div>
          <div class="m-project">{{ item.project }}</div>
        </li>
      </ul>
    </div>
    
    <div class="actions">
      <router-link to="/settings">Go to Settings</router-link>
    </div>
  </div>
</template>

<style scoped>
.init-container {
  padding: 2rem;
  max-width: 500px;
  margin: 0 auto;
}
.form-group {
  margin-bottom: 1rem;
}
input {
  width: 100%;
  padding: 0.5rem;
  margin-top: 0.5rem;
  background: #333;
  color: white;
  border: 1px solid #555;
}
button {
  padding: 0.5rem 1rem;
  background: #007bff;
  color: white;
  border: none;
  cursor: pointer;
}
button:disabled {
  background: #555;
}
.error {
  color: #ff4444;
  margin-top: 1rem;
  white-space: pre-line;
}
.history-section {
  margin-top: 2rem;
  border-top: 1px solid #444;
  padding-top: 1rem;
}
.history-section h3 {
  font-size: 1rem;
  margin-bottom: 1rem;
  color: #aaa;
}
.history-list {
  list-style: none;
  padding: 0;
}
.history-item {
  padding: 0.75rem;
  background: #2a2d2e;
  border: 1px solid #3c3c3c;
  border-radius: 4px;
  margin-bottom: 0.5rem;
  cursor: pointer;
  transition: background 0.2s;
}
.history-item:hover {
  background: #37373d;
}
.m-title {
  font-weight: bold;
  font-size: 0.9rem;
  margin-bottom: 0.2rem;
}
.m-project {
  font-size: 0.75rem;
  color: #888;
}
.actions {
  margin-top: 1rem;
}
a {
  color: #007bff;
  text-decoration: none;
}
</style>