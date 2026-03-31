<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useReviewStore } from '../store';
import SecurityBanner from '../components/SecurityBanner.vue';

import { createProvider, parseUrl, BaseProvider } from '../providers';

const router = useRouter();
const reviewStore = useReviewStore();
const mrUrl = ref('');
const loading = ref(false);
const errorMsg = ref('');
const recentMrs = ref<Array<{ url: string, title: string, project: string }>>([]);

onMounted(async () => {
  console.log('[Init] App mounted, checking for tokens...');
  await reviewStore.initializeStorageStatus();
  
  const glRes = await window.electronAPI.getSecret('gitlab_pat');
  console.log('[Init] getSecret gitlab_pat result:', glRes);
  
  const ghRes = await window.electronAPI.getSecret('github_pat');
  console.log('[Init] getSecret github_pat result:', ghRes);
  
  const legacyGl = localStorage.getItem('gitlab_pat');
  const legacyGh = localStorage.getItem('github_pat');
  if (legacyGl) console.log('[Init] Found legacy gitlab_pat in localStorage');
  if (legacyGh) console.log('[Init] Found legacy github_pat in localStorage');

  const hasAnyToken = (glRes.success && glRes.value) || 
                       (ghRes.success && ghRes.value) ||
                       legacyGl || 
                       legacyGh;
                       
  if (!hasAnyToken) {
    console.warn('[Init] No tokens found in secure storage or localStorage, redirecting to /settings');
    router.push('/settings');
  } else {
    console.log('[Init] Tokens found, ready to review.');
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

// Removed platform-specific init functions, now handled by providers

// --- Main entry ---

const initializeReview = async () => {
  loading.value = true;
  errorMsg.value = '';

  try {
    const provider = createProvider(mrUrl.value);
    const parsed = parseUrl(mrUrl.value);
    
    await provider.initialize(parsed);
    
    // Sycn store with provider data
    reviewStore.activeProvider = provider;
    reviewStore.mrData = provider.mrData;
    reviewStore.diffs = provider.diffs;
    reviewStore.currentUser = provider.currentUser;
    reviewStore.platform = provider.platform;
    reviewStore.remoteComments = provider.remoteComments;
    reviewStore.codeownersRules = provider.codeownersRules;

    // Cache file ownership for all changed files
    if (reviewStore.codeownersRules.length > 0) {
      const filePaths = reviewStore.diffs.map(f => f.new_path);
      reviewStore.fileOwners = await window.electronAPI.matchCodeownersBulk(filePaths, provider.codeownersRules);
    } else {
      reviewStore.fileOwners = {};
    }

    saveToHistory(mrUrl.value, provider.mrData?.title || '', parsed.projectPath);
    
    if (provider.diffs.length > 0) {
      reviewStore.selectFile(provider.diffs[0].new_path);
    }

    router.push('/review');
  } catch (err) {
    errorMsg.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
};

</script>

<template>
  <div class="init-container">
    <SecurityBanner />
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