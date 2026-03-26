import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig(async () => {
  // eslint-disable-next-line import/no-unresolved
  const vue = (await import('@vitejs/plugin-vue')).default;
  
  return {
    worker: {
      format: 'es'
    },
    plugins: [vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag: string) => ['file-diff', 'diffs-container'].includes(tag)
        }      }
    })]
  };
});
