<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const token = ref('');

const saveToken = () => {
  localStorage.setItem('gitlab_pat', token.value);
  router.push('/');
};

// load token on mount
token.value = localStorage.getItem('gitlab_pat') || '';
</script>

<template>
  <div class="settings-container">
    <h2>Settings</h2>
    <div class="form-group">
      <label for="token">GitLab Personal Access Token</label>
      <input id="token" v-model="token" type="password" placeholder="glpat-..." />
    </div>
    <button @click="saveToken">Save</button>
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
input {
  width: 100%;
  padding: 0.5rem;
  margin-top: 0.5rem;
}
</style>