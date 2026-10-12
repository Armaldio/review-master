export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  ssr: false,
  devtools: { enabled: false },
  modules: ['@nuxt/eslint'],
  css: ['~/assets/main.css', '~/assets/controls.css'],
  nitro: { preset: 'node-server' },
  runtimeConfig: {},
  routeRules: { '/**': { headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' } } },
  typescript: { strict: true, typeCheck: true },
});
