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
  if (!localStorage.getItem('gitlab_pat')) {
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
  history = history.slice(0, 5); // Keep last 5
  recentMrs.value = history;
  localStorage.setItem('mr_history', JSON.stringify(history));
};

const loadFromHistory = (url: string) => {
  mrUrl.value = url;
  initializeReview();
};

const initializeReview = async () => {
  loading.value = true;
  errorMsg.value = '';
  
  try {
    const pat = localStorage.getItem('gitlab_pat');
    if (!pat) throw new Error('No PAT found');

    const targetUrl = mrUrl.value;
    // Parse MR URL (e.g., https://gitlab.com/my-org/my-project/-/merge_requests/42)
    const urlObj = new URL(targetUrl);
    const host = urlObj.origin;
    
    // Extract project path and IID
    const match = urlObj.pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)/);
    if (!match) throw new Error('Invalid MR URL format');
    
    const projectPath = match[1];
    const mrIid = match[2];
    const encodedProjectPath = encodeURIComponent(projectPath);

    // 1. Clone/Fetch repo locally via IPC
    const appData = await window.electronAPI.getAppPath();
    const targetPath = `${appData}/review-master-repos/${projectPath}`;
    const cloneUrl = `${host}/${projectPath}.git`.replace('https://', `https://oauth2:${pat}@`);

    const cloneRes = await window.electronAPI.cloneRepo(cloneUrl, targetPath);
    if (!cloneRes.success) throw new Error(`Clone failed: ${cloneRes.error}`);

    // 2. Fetch MR details and diffs from GitLab API
    const diffsRes = await fetch(`${host}/api/v4/projects/${encodedProjectPath}/merge_requests/${mrIid}/diffs`, {
      headers: { 'PRIVATE-TOKEN': pat }
    });
    
    if (!diffsRes.ok) throw new Error(`Failed to fetch diffs: ${diffsRes.statusText}`);
    const diffs = await diffsRes.json();

    const infoRes = await fetch(`${host}/api/v4/projects/${encodedProjectPath}/merge_requests/${mrIid}`, {
      headers: { 'PRIVATE-TOKEN': pat }
    });
    const mrData = await infoRes.json();

    // Save to history on success
    saveToHistory(targetUrl, mrData.title, projectPath);

    const versionsRes = await fetch(`${host}/api/v4/projects/${encodedProjectPath}/merge_requests/${mrIid}/versions`, {
      headers: { 'PRIVATE-TOKEN': pat }
    });
    const versions = await versionsRes.json();
    const latestVersion = versions[0];

    // 3. Fetch current user info
    const userRes = await fetch(`${host}/api/v4/user`, {
      headers: { 'PRIVATE-TOKEN': pat }
    });
    if (!userRes.ok) throw new Error('Failed to fetch user info');
    const userData = await userRes.json();

    // 4. Try to read CODEOWNERS from local clone
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

    // Save to store
    reviewStore.mrData = { ...mrData, latestVersion, host, encodedProjectPath, mrIid };
    reviewStore.diffs = diffs;
    reviewStore.currentUser = userData;
    reviewStore.codeownersRules = rules;
    
    // Mark first file as selected if available
    if (diffs.length > 0) {
      reviewStore.selectFile(diffs[0].new_path);
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
      <label for="mrUrl">GitLab Merge Request URL</label>
      <input id="mrUrl" v-model="mrUrl" type="text" placeholder="https://gitlab.com/org/project/-/merge_requests/1" />
    </div>
    <button @click="initializeReview" :disabled="loading">
      {{ loading ? 'Loading...' : 'Start Review' }}
    </button>
    
    <div v-if="errorMsg" class="error">{{ errorMsg }}</div>

    <div v-if="recentMrs.length > 0" class="history-section">
      <h3>Recent Merge Requests</h3>
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