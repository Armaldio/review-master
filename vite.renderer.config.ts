import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";

// https://vitejs.dev/config
export default defineConfig({
  worker: {
    format: "es",
  },
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // treat all tags starting with 'diffs-' as custom elements
          isCustomElement: (tag) => tag.startsWith("diffs-"),
        },
      },
    }),
  ],
});
