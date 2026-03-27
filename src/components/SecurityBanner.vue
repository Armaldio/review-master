<script setup lang="ts">
import { ref } from 'vue';
import { useReviewStore } from '../store';

const store = useReviewStore();
const showHelp = ref(false);

const toggleHelp = () => {
  showHelp.value = !showHelp.value;
};
</script>

<template>
  <div v-if="!store.isSecureStorageAvailable" class="security-banner">
    <div class="banner-content">
      <span class="icon">⚠️</span>
      <div class="message">
        <strong>Insecure Storage Active:</strong> 
        Your OS keyring service (e.g. gnome-keyring) is missing or unavailable. 
        Tokens are being stored <strong>unencrypted</strong> in localStorage.
      </div>
      <button class="help-btn" @click="toggleHelp">
        {{ showHelp ? 'Hide Fix' : 'How to Fix?' }}
      </button>
    </div>
    
    <div v-if="showHelp" class="help-details">
      <h4>How to enable Secure Storage on Linux</h4>
      <p>Install the most popular secret service (gnome-keyring):</p>
      
      <div class="command-box">
        <label>Ubuntu / Debian / Mint:</label>
        <code>sudo apt install gnome-keyring libsecret-1-0</code>
      </div>
      
      <div class="command-box">
        <label>Fedora / RedHat:</label>
        <code>sudo dnf install gnome-keyring</code>
      </div>

      <div class="command-box">
        <label>Arch Linux:</label>
        <code>sudo pacman -S gnome-keyring</code>
      </div>

      <p class="note"><strong>Note:</strong> After installation, please restart your session (log out and log back in) and restart the application.</p>
    </div>
  </div>
</template>

<style scoped>
.security-banner {
  background: #4a3e00;
  border: 1px solid #9a7d00;
  color: #fff;
  padding: 1rem;
  margin-bottom: 2rem;
  border-radius: 8px;
  font-size: 0.9rem;
}
.banner-content {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.icon {
  font-size: 1.5rem;
}
.message {
  flex: 1;
}
.help-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: white;
  padding: 0.4rem 0.8rem;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.help-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}
.help-details {
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}
.help-details h4 {
  margin: 0 0 1rem 0;
  color: #ffd700;
}
.command-box {
  background: #000;
  padding: 0.75rem;
  border-radius: 4px;
  margin-bottom: 0.75rem;
}
.command-box label {
  display: block;
  font-size: 0.75rem;
  color: #888;
  margin-bottom: 0.25rem;
}
code {
  font-family: monospace;
  color: #50fa7b;
}
.note {
  margin-top: 1rem;
  font-style: italic;
  color: #ccc;
}
</style>
