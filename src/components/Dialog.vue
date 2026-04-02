<script setup lang="ts">
const props = defineProps<{
  show: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  type?: 'info' | 'danger' | 'warning';
}>();

const emit = defineEmits(['confirm', 'cancel', 'update:show']);

const close = () => {
  emit('update:show', false);
  emit('cancel');
};

const confirm = () => {
  emit('confirm');
  emit('update:show', false);
};
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="dialog-overlay" @click.self="close">
      <div class="dialog-content" :class="type || 'info'">
        <div class="dialog-header">
          <h3>{{ title }}</h3>
          <button class="close-btn" @click="close">&times;</button>
        </div>
        <div class="dialog-body">
          <p v-if="message">{{ message }}</p>
          <slot></slot>
        </div>
        <div class="dialog-footer">
          <button class="btn-dialog-secondary" @click="close">
            {{ cancelLabel || 'Cancel' }}
          </button>
          <button 
            class="btn-dialog-primary" 
            :class="{ 'btn-danger': type === 'danger' }"
            @click="confirm"
          >
            {{ confirmLabel || 'Confirm' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 11000;
  backdrop-filter: blur(4px);
}

.dialog-content {
  background: #1e1e1e;
  border: 1px solid #333;
  border-radius: 12px;
  width: 440px;
  max-width: 90vw;
  padding: 24px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  animation: dialog-appear 0.2s ease-out;
}

@keyframes dialog-appear {
  from { opacity: 0; transform: scale(0.95) translateY(10px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.dialog-header h3 {
  margin: 0;
  font-size: 18px;
  color: #fff;
}

.close-btn {
  background: transparent;
  border: none;
  color: #666;
  font-size: 24px;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.close-btn:hover {
  color: #fff;
}

.dialog-body {
  margin-bottom: 24px;
  color: #ccc;
  font-size: 14px;
  line-height: 1.6;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.btn-dialog-primary, .btn-dialog-secondary {
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-dialog-primary {
  background: #007acc;
  color: #fff;
  border: none;
}

.btn-dialog-primary:hover {
  background: #0062a3;
}

.btn-dialog-primary.btn-danger {
  background: #d73a49;
}

.btn-dialog-primary.btn-danger:hover {
  background: #cb2431;
}

.btn-dialog-secondary {
  background: #333;
  color: #ccc;
  border: 1px solid #444;
}

.btn-dialog-secondary:hover {
  background: #444;
  color: #fff;
}
</style>
