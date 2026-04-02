<script setup lang="ts">
import ToastContainer from './components/ToastContainer.vue';
</script>

<template>
  <div class="app-container">
    <router-view />
    <ToastContainer />
  </div>
</template>

<style>
/* Basic app container layout */
.app-container {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
}
</style>
