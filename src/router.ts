import { createRouter, createWebHashHistory } from 'vue-router';
import InitView from './views/InitView.vue';
import SettingsView from './views/SettingsView.vue';
import ReviewView from './views/ReviewView.vue';

const routes = [
  { path: '/', component: InitView },
  { path: '/settings', component: SettingsView },
  { path: '/review', component: ReviewView },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;