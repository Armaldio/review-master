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
  let gitlabSaved = true;
  let githubSaved = true;

  if (gitlabToken.value) {
    const res = await window.electronAPI.setSecret('gitlab_pat', gitlabToken.value);
    gitlabSaved = res.success;
  }
  if (githubToken.value) {
    const res = await window.electronAPI.setSecret('github_pat', githubToken.value);
    githubSaved = res.success;
  }
  
  // Clear any legacy plain text tokens only if secure storage actually worked
  if (gitlabSaved) {
    localStorage.removeItem('gitlab_pat');
  }
  if (githubSaved) {
    localStorage.removeItem('github_pat');
  }
  
  router.push('/');
};

// load tokens on mount
onMounted(async () => {
  await store.initializeStorageStatus();
  
  // 1. Try to load from secure storage
  const glRes = await window.electronAPI.getSecret('gitlab_pat');
  const ghRes = await window.electronAPI.getSecret('github_pat');
  
  if (glRes.success && glRes.value) {
    gitlabToken.value = glRes.value;
  } else {
    // Migration: Check if they exist in localStorage
    const legacyGl = localStorage.getItem('gitlab_pat');
    if (legacyGl) {
      console.warn('[Storage] Found legacy GitLab PAT in localStorage. It will be moved to secure storage upon clicking Save.');
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