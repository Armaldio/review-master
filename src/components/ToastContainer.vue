<script setup lang="ts">
import { useReviewStore } from '../store';

const store = useReviewStore();
</script>

<template>
  <div class="toast-container">
    <TransitionGroup name="toast">
      <div
        v-for="toast in store.toasts"
        :key="toast.id"
        class="toast-item"
        :class="toast.type"
        @click="store.removeToast(toast.id)"
      >
        <div class="toast-icon">
          <span v-if="toast.type === 'success'">✓</span>
          <span v-else-if="toast.type === 'error'">✕</span>
          <span v-else>ℹ</span>
        </div>
        <div class="toast-message">{{ toast.message }}</div>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-container {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none;
}

.toast-item {
  pointer-events: auto;
  min-width: 280px;
  max-width: 400px;
  padding: 12px 16px;
  border-radius: 8px;
  background: #2d2d2d;
  color: #fff;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  border: 1px solid #444;
  backdrop-filter: blur(8px);
  user-select: none;
}

.toast-item.success {
  border-left: 4px solid #4caf50;
}

.toast-item.error {
  border-left: 4px solid #f44336;
}

.toast-item.info {
  border-left: 4px solid #007acc;
}

.toast-icon {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 12px;
  font-weight: bold;
  flex-shrink: 0;
}

.success .toast-icon { background: rgba(76, 175, 80, 0.2); color: #4caf50; }
.error .toast-icon { background: rgba(244, 67, 54, 0.2); color: #f44336; }
.info .toast-icon { background: rgba(0, 122, 204, 0.2); color: #007acc; }

.toast-message {
  font-size: 14px;
  line-height: 1.4;
  flex: 1;
}

/* Animations */
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(30px);
}

.toast-leave-to {
  opacity: 0;
  transform: scale(0.9);
}
</style>
