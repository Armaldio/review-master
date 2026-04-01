<script setup lang="ts">
// Simple, elegant static empty state with SVG icons
defineProps<{
  title?: string;
  description?: string;
  type?: 'select-file' | 'no-discussions' | 'no-results';
}>();
</script>

<template>
  <div class="empty-state-container">
    <div class="icon-wrapper">
      <!-- File selection icon -->
      <svg v-if="type === 'select-file' || !type" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
        <polyline points="13 2 13 9 20 9"></polyline>
      </svg>
      <!-- Discussions icon -->
      <svg v-else-if="type === 'no-discussions'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
      <!-- No search results icon -->
      <svg v-else-if="type === 'no-results'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="11" cy="11" r="8"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
    </div>
    
    <h3>{{ title || (type === 'no-discussions' ? 'No discussions found' : 'Select a file to review') }}</h3>
    <p>{{ description || (type === 'no-discussions' ? 'All threads are resolved or no comments have been made.' : 'Choose a file from the sidebar to start your review.') }}</p>
  </div>
</template>

<style scoped>
.empty-state-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 100%;
  padding: 2rem;
  text-align: center;
  color: #8b949e;
  animation: fadeIn 0.4s ease-out;
}

.icon-wrapper {
  width: 64px;
  height: 64px;
  background: rgba(139, 148, 158, 0.05);
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 1.5rem;
  color: #30363d;
}

.icon-wrapper svg {
  width: 32px;
  height: 32px;
}

h3 {
  color: #c9d1d9;
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0 0 0.5rem 0;
}

p {
  font-size: 0.9rem;
  max-width: 300px;
  line-height: 1.5;
  margin: 0;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
