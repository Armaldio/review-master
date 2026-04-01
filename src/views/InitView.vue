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
    reviewStore.fetchRecentActivity();
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
    await reviewStore.initializeMR(mrUrl.value);
    saveToHistory(mrUrl.value, reviewStore.mrData?.title || '', parseUrl(mrUrl.value).projectPath);
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

    <div class="active-mrs-section">
      <div class="section-header">
        <h3>Active Merge Requests</h3>
        <button class="btn-icon" @click="reviewStore.fetchRecentActivity" :disabled="reviewStore.isLiveLoading" title="Refresh">
          <span :class="{ 'spinning': reviewStore.isLiveLoading }">↻</span>
        </button>
      </div>

      <div v-if="reviewStore.isLiveLoading && reviewStore.liveMRs.length === 0" class="loading-placeholder">
        <div class="skeleton-card" v-for="i in 3" :key="i"></div>
      </div>

      <div v-else-if="reviewStore.liveMRs.length === 0" class="empty-activity">
        No active MRs found for your accounts.
      </div>

      <div v-else class="mr-grid">
        <div v-for="mr in reviewStore.liveMRs" :key="mr.url" class="mr-card" @click="loadFromHistory(mr.url)">
          <div class="mr-card-header">
            <span class="platform-icon" :class="mr.platform">{{ mr.platform === 'github' ? 'G' : 'L' }}</span>
            <span v-if="mr.draft" class="draft-badge">Draft</span>
          </div>
          <div class="mr-card-body">
            <div class="mr-title" :title="mr.title">{{ mr.title }}</div>
            <div class="mr-repo">{{ mr.repository }}</div>
          </div>
          <div class="mr-card-footer">
            <span class="mr-author">by {{ mr.author }}</span>
            <span class="mr-date">{{ formatRelativeTime(mr.updated_at) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="recentMrs.length > 0" class="history-section">
      <h3>Recently Visited</h3>
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

<script lang="ts">
/**
 * Helper to format relative time (e.g. "2h ago")
 */
function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffDay > 0) return `${diffDay}d ago`;
  if (diffHour > 0) return `${diffHour}h ago`;
  if (diffMin > 0) return `${diffMin}m ago`;
  return 'Just now';
}
</script>

<style scoped>
.init-container {
  padding: 2.5rem;
  max-width: 800px;
  margin: 0 auto;
}
.form-group {
  margin-bottom: 2rem;
}
label {
  font-size: 0.9rem;
  font-weight: 500;
  color: #ccc;
  margin-bottom: 0.5rem;
  display: block;
}
input {
  width: 100%;
  padding: 0.8rem 1rem;
  background: #1e1e1e;
  color: white;
  border: 1px solid #333;
  border-radius: 8px;
  font-size: 0.95rem;
  transition: border-color 0.2s, box-shadow 0.2s;
}
input:focus {
  outline: none;
  border-color: #007bff;
  box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.15);
}
button {
  padding: 0.8rem 1.5rem;
  background: #007bff;
  color: white;
  border: none;
  cursor: pointer;
  border-radius: 8px;
  font-weight: 600;
  transition: background 0.2s, transform 0.1s;
}
button:hover:not(:disabled) {
  background: #0069d9;
}
button:active:not(:disabled) {
  transform: translateY(1px);
}
button:disabled {
  background: #333;
  color: #666;
  cursor: not-allowed;
}

.active-mrs-section {
  margin-top: 3rem;
  border-top: 1px solid #333;
  padding-top: 2rem;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.section-header h3 {
  font-size: 1.1rem;
  font-weight: 600;
  color: #eee;
  margin: 0;
}

.btn-icon {
  background: transparent;
  border: none;
  color: #888;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.2rem;
  line-height: 1;
}
.btn-icon:hover {
  color: white;
  background: transparent;
}

.spinning {
  display: inline-block;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.mr-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1.25rem;
  margin-bottom: 2rem;
}

.mr-card {
  background: #252526;
  border: 1px solid #333;
  border-radius: 12px;
  padding: 1.25rem;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.mr-card:hover {
  background: #2d2d30;
  border-color: #444;
  transform: translateY(-2px);
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.4);
}

.mr-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.platform-icon {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: bold;
  color: white;
}
.platform-icon.gitlab { background: #e24329; }
.platform-icon.github { background: #24292e; color: #fff; border: 1px solid #444; }

.draft-badge {
  font-size: 10px;
  background: #333;
  color: #aaa;
  padding: 2px 6px;
  border-radius: 10px;
  font-weight: 500;
  text-transform: uppercase;
  border: 1px solid #444;
}

.mr-card-body {
  flex: 1;
}

.mr-title {
  font-weight: 600;
  font-size: 0.95rem;
  line-height: 1.4;
  color: #eee;
  margin-bottom: 0.4rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.mr-repo {
  font-size: 0.75rem;
  color: #8b949e;
  font-family: monospace;
}

.mr-card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.75rem;
  color: #6e7681;
  padding-top: 0.75rem;
  border-top: 1px solid #333;
}

.loading-placeholder {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1.25rem;
}

.skeleton-card {
  height: 140px;
  background: #252526;
  border-radius: 12px;
  animation: pulse 1.5s infinite ease-in-out;
}

@keyframes pulse {
  0% { opacity: 1; }
  50% { opacity: 0.5; }
  100% { opacity: 1; }
}

.empty-activity {
  text-align: center;
  padding: 2rem;
  background: #1e1e1e;
  border: 1px dashed #333;
  border-radius: 12px;
  color: #666;
  font-size: 0.9rem;
}

.error {
  color: #ff4444;
  margin: 1rem 0;
  background: rgba(255, 68, 68, 0.1);
  padding: 0.75rem;
  border-radius: 6px;
  font-size: 0.85rem;
}

.history-section {
  margin-top: 3rem;
  border-top: 1px solid #333;
  padding-top: 2rem;
}
.history-section h3 {
  font-size: 1rem;
  margin-bottom: 1rem;
  color: #888;
}
.history-list {
  list-style: none;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 0.75rem;
}
.history-item {
  padding: 0.75rem 1rem;
  background: #1e1e1e;
  border: 1px solid #333;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
}
.history-item:hover {
  background: #2d2d30;
  border-color: #444;
}

.actions {
  margin-top: 3rem;
  text-align: center;
}
a {
  color: #58a6ff;
  text-decoration: none;
  font-size: 0.9rem;
}
a:hover {
  text-decoration: underline;
}
</style>