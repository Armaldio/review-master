<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useReviewStore } from '../store';
import SecurityBanner from '../components/SecurityBanner.vue';

const router = useRouter();
const store = useReviewStore();

const isAdding = ref(false);
const newAccount = ref({
  platform: 'gitlab' as 'gitlab' | 'github',
  host: 'https://gitlab.com',
  token: ''
});
const error = ref('');
const loading = ref(false);

const openExternal = (url: string) => {
  window.electronAPI.openExternal(url);
};

const handleAddAccount = async () => {
  if (!newAccount.value.token) return;
  
  error.value = '';
  loading.value = true;
  try {
    const host = newAccount.value.platform === 'github' ? 'https://github.com' : newAccount.value.host;
    await store.addAccount(newAccount.value.platform, host, newAccount.value.token);
    isAdding.value = false;
    newAccount.value.token = '';
    newAccount.value.host = 'https://gitlab.com';
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
};

const removeAccount = async (id: string) => {
  if (confirm('Are you sure you want to remove this account? Tokens will be deleted from secure storage.')) {
    await store.removeAccount(id);
  }
};
</script>

<template>
  <div class="settings-container">
    <SecurityBanner />
    <div class="header">
      <h2>Account Settings</h2>
      <button v-if="!isAdding" class="add-btn" @click="isAdding = true">+ Add Account</button>
    </div>

    <div v-if="isAdding" class="add-account-form card">
      <h3>Add New Account</h3>
      <div class="form-group">
        <label>Platform</label>
        <div class="platform-tabs">
          <button 
            :class="{ active: newAccount.platform === 'gitlab' }" 
            @click="newAccount.platform = 'gitlab'; newAccount.host = 'https://gitlab.com'"
          >GitLab</button>
          <button 
            :class="{ active: newAccount.platform === 'github' }" 
            @click="newAccount.platform = 'github'; newAccount.host = 'https://github.com'"
          >GitHub</button>
        </div>
      </div>

      <div class="form-group" v-if="newAccount.platform === 'gitlab'">
        <label>Host URL</label>
        <input v-model="newAccount.host" placeholder="https://gitlab.com" />
      </div>

      <div class="form-group">
        <label>
          Personal Access Token
          <a v-if="newAccount.platform === 'gitlab'" href="#" @click.prevent="openExternal(newAccount.host + '/-/user_settings/personal_access_tokens?name=ReviewMaster&scopes=api,read_user')" class="gen-link">Generate</a>
          <a v-else href="#" @click.prevent="openExternal('https://github.com/settings/tokens/new?scopes=repo,read:org,read:user,user:email')" class="gen-link">Generate</a>
        </label>
        <input v-model="newAccount.token" type="password" :placeholder="newAccount.platform === 'gitlab' ? 'glpat-...' : 'ghp_...'" />
      </div>

      <p v-if="error" class="error-text">{{ error }}</p>

      <div class="form-actions">
        <button class="secondary" @click="isAdding = false" :disabled="loading">Cancel</button>
        <button @click="handleAddAccount" :disabled="loading || !newAccount.token">
          {{ loading ? 'Verifying...' : 'Verify & Add' }}
        </button>
      </div>
    </div>

    <div class="account-list">
      <div v-if="store.accounts.length === 0" class="empty-state">
        No accounts connected yet. Add one to start reviewing.
      </div>
      <div v-for="account in store.accounts" :key="account.id" class="account-card card">
        <div class="account-info">
          <img :src="account.avatar_url" class="avatar" v-if="account.avatar_url" />
          <div class="details">
            <div class="name-row">
              <span class="username">{{ account.username }}</span>
              <span class="platform-badge" :class="account.platform">{{ account.platform }}</span>
            </div>
            <div class="host">{{ account.host }}</div>
          </div>
        </div>
        <button class="remove-btn" @click="removeAccount(account.id)" title="Remove account">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6"/></svg>
        </button>
      </div>
    </div>

    <div class="footer-actions" v-if="store.accounts.length > 0">
      <button class="primary-big" @click="router.push('/')">Go to Home</button>
    </div>
  </div>
</template>

<style scoped>
.settings-container {
  padding: 2.5rem;
  max-width: 600px;
  margin: 0 auto;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2rem;
}

h2 { margin: 0; font-size: 1.5rem; }

.add-btn {
  background: #238636;
  font-size: 0.9rem;
  padding: 0.5rem 1rem;
}
.add-btn:hover { background: #2ea043; }

.card {
  background: #1e1e1e;
  border: 1px solid #333;
  border-radius: 12px;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
}

.add-account-form h3 {
  margin-top: 0;
  margin-bottom: 1.5rem;
  font-size: 1.1rem;
}

.form-group {
  margin-bottom: 1.25rem;
}

label {
  display: flex;
  justify-content: space-between;
  font-size: 0.85rem;
  color: #888;
  margin-bottom: 0.5rem;
}

.platform-tabs {
  display: flex;
  gap: 0.5rem;
  background: #161b22;
  padding: 0.25rem;
  border-radius: 8px;
}

.platform-tabs button {
  flex: 1;
  background: transparent;
  color: #888;
  border: none;
  padding: 0.5rem;
  font-size: 0.9rem;
}

.platform-tabs button.active {
  background: #333;
  color: white;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}

input {
  width: 100%;
  padding: 0.75rem;
  background: #0d1117;
  color: white;
  border: 1px solid #30363d;
  border-radius: 6px;
  font-size: 0.95rem;
}

input:focus {
  outline: none;
  border-color: #58a6ff;
  box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.1);
}

.gen-link { color: #58a6ff; text-decoration: none; font-size: 0.8rem; }
.gen-link:hover { text-decoration: underline; }

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 1rem;
  margin-top: 2rem;
}

.error-text { color: #f85149; font-size: 0.85rem; margin-top: 0.5rem; }

.account-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.25rem;
  transition: border-color 0.2s;
}

.account-card:hover { border-color: #444; }

.account-info {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #333;
}

.details { display: flex; flex-direction: column; gap: 0.2rem; }

.name-row { display: flex; align-items: center; gap: 0.5rem; }

.username { font-weight: 600; color: #eee; }

.platform-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  font-weight: bold;
}
.platform-badge.github { background: #24292e; color: white; border: 1px solid #444; }
.platform-badge.gitlab { background: #e24329; color: white; }

.host { font-size: 0.75rem; color: #6e7681; font-family: monospace; }

.remove-btn {
  background: transparent;
  color: #f85149;
  border: none;
  padding: 8px;
  opacity: 0.6;
  transition: opacity 0.2s, background 0.2s;
}
.remove-btn:hover { opacity: 1; background: rgba(248, 81, 73, 0.1); }

.empty-state {
  text-align: center;
  padding: 3rem;
  color: #666;
  background: #161b22;
  border: 1px dashed #333;
  border-radius: 12px;
}

.footer-actions {
  margin-top: 3rem;
  display: flex;
  justify-content: center;
}

.primary-big {
  width: 100%;
  max-width: 300px;
  padding: 1rem;
  font-size: 1rem;
}

button.secondary { background: #333; color: white; }
button.secondary:hover { background: #444; }

button {
  padding: 0.7rem 1.2rem;
  background: #007bff;
  color: white;
  border: none;
  cursor: pointer;
  border-radius: 8px;
  font-weight: 600;
  transition: all 0.2s;
}

button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>