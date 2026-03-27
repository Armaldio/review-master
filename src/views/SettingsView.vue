<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const gitlabToken = ref('');
const githubToken = ref('');

const saveTokens = () => {
  localStorage.setItem('gitlab_pat', gitlabToken.value);
  localStorage.setItem('github_pat', githubToken.value);
  router.push('/');
};

// load tokens on mount
gitlabToken.value = localStorage.getItem('gitlab_pat') || '';
githubToken.value = localStorage.getItem('github_pat') || '';
</script>

<template>
  <div class="settings-container">
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