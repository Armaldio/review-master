<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useReviewStore } from '../store';
import SecurityBanner from '../components/SecurityBanner.vue';

const router = useRouter();
const store = useReviewStore();
const gitlabToken = ref('');
const githubToken = ref('');

const saveTokens = async () => {
  console.log('[Settings] Starting saveTokens...');
  if (gitlabToken.value) {
    console.log('[Settings] Saving GitLab PAT...');
    const res = await window.electronAPI.setSecret('gitlab_pat', gitlabToken.value);
    console.log('[Settings] setSecret gitlab_pat result:', res);
    if (res.success) {
      localStorage.removeItem('gitlab_pat');
    } else {
      console.warn('[Settings] Secure storage failed for GitLab PAT, saving to localStorage instead.');
      localStorage.setItem('gitlab_pat', gitlabToken.value);
    }
  }
  if (githubToken.value) {
    console.log('[Settings] Saving GitHub PAT...');
    const res = await window.electronAPI.setSecret('github_pat', githubToken.value);
    console.log('[Settings] setSecret github_pat result:', res);
    if (res.success) {
      localStorage.removeItem('github_pat');
    } else {
      console.warn('[Settings] Secure storage failed for GitHub PAT, saving to localStorage instead.');
      localStorage.setItem('github_pat', githubToken.value);
    }
  }
  
  console.log('[Settings] Save complete, redirecting to home...');
  router.push('/');
};

// load tokens on mount
onMounted(async () => {
  console.log('[Settings] App mounted, checking for tokens...'); // Added log
  await store.initializeStorageStatus();
  
  // 1. Try to load from secure storage
  const glRes = await window.electronAPI.getSecret('gitlab_pat');
  console.log('[Settings] getSecret gitlab_pat result:', glRes); // Added log
  const ghRes = await window.electronAPI.getSecret('github_pat');
  console.log('[Settings] getSecret github_pat result:', ghRes); // Added log
  
  if (glRes.success && glRes.value) {
    gitlabToken.value = glRes.value;
  } else {
    // Migration: Check if they exist in localStorage
    const legacyGl = localStorage.getItem('gitlab_pat');
    if (legacyGl) {
      console.log('[Settings] Found legacy GitLab PAT in localStorage.'); // Added log
      console.warn('[Settings] Found legacy GitLab PAT in localStorage. It will be moved to secure storage upon clicking Save.');
      gitlabToken.value = legacyGl;
    }
  }

  if (ghRes.success && ghRes.value) {
    githubToken.value = ghRes.value;
  } else {
    // Migration: Check if they exist in localStorage
    const legacyGh = localStorage.getItem('github_pat');
    if (legacyGh) {
      console.warn('[Storage] Found legacy GitHub PAT in localStorage. It will be moved to secure storage upon clicking Save.');
      githubToken.value = legacyGh;
    }
  }
});
</script>

<template>
  <div class="settings-container">
    <SecurityBanner />
    <h2>Settings</h2>
    <div class="form-group">
      <label for="gitlab-token">GitLab Personal Access Token</label>
      <input id="gitlab-token" v-model="gitlabToken" type="password" placeholder="glpat-..." />
    </div>
    <div class="form-group">
      <label for="github-token">GitHub Personal Access Token</label>
      <input id="github-token" v-model="githubToken" type="password" placeholder="ghp_..." />
    </div>
    <p class="hint">At least one token is required.</p>
    <button @click="saveTokens" :disabled="!gitlabToken && !githubToken">Save</button>
  </div>
</template>

<style scoped>
.settings-container {
  padding: 2rem;
  max-width: 400px;
  margin: 0 auto;
}
.form-group {
  margin-bottom: 1rem;
}
label {
  display: block;
  margin-bottom: 0.25rem;
  font-size: 0.9rem;
  color: #ccc;
}
input {
  width: 100%;
  padding: 0.5rem;
  margin-top: 0.25rem;
  background: #333;
  color: white;
  border: 1px solid #555;
  border-radius: 4px;
}
.hint {
  font-size: 0.8rem;
  color: #888;
  margin-bottom: 1rem;
}
button {
  padding: 0.5rem 1rem;
  background: #007bff;
  color: white;
  border: none;
  cursor: pointer;
  border-radius: 4px;
}
button:disabled {
  background: #555;
}
</style>