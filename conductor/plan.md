# Plan to Fix Vite Import Analysis Error

## Objective

Fix the following Vite import analysis error:
`[plugin:vite:import-analysis] Missing "./style" specifier in "@pierre/diffs" package`

## Root Cause

The `@pierre/diffs` package, a dependency in this project, does not correctly export its stylesheet in the `exports` map of its `package.json`. This is a packaging issue in the library itself. As a result, Vite's resolver cannot find the module when `src/components/PierreDiff.vue` tries to import it via `@pierre/diffs/style`.

The import in `src/components/PierreDiff.vue` is:
```typescript
// @ts-ignore
import style_default from '@pierre/diffs/style';
```

## Proposed Solution

The most direct and least intrusive way to fix this without modifying the library itself is to tell Vite how to resolve this specific import path. I will create a resolve alias in the `vite.renderer.config.ts` file.

This alias will map the import path `'@pierre/diffs/style'` to the actual path of the stylesheet file on disk, which is `node_modules/@pierre/diffs/dist/style.js`.

### Implementation Steps

1.  **Modify `vite.renderer.config.ts`**:
    *   I will add a `resolve.alias` configuration to the Vite config.
    *   This will require importing the `path` module to create an absolute path to the file in `node_modules`.

The updated `vite.renderer.config.ts` will look like this:

```typescript
import { defineConfig } from 'vite';
import path from 'path';

// https://vitejs.dev/config
export default defineConfig(async () => {
  // eslint-disable-next-line import/no-unresolved
  const vue = (await import('@vitejs/plugin-vue')).default;
  
  return {
    worker: {
      format: 'es'
    },
    resolve: {
      alias: {
        '@pierre/diffs/style': path.resolve(__dirname, '../../node_modules/@pierre/diffs/dist/style.js')
      }
    },
    plugins: [vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag: string) => ['file-diff', 'diffs-container'].includes(tag)
        }      }
    })]
  };
});
```
*Note: The path in `path.resolve` is constructed to be correct relative to the location of the config file in the project structure.*

## Verification

After applying this change, running the Vite development server (`npm run start`) should no longer produce the `[plugin:vite:import-analysis]` error, and the styles for the `@pierre/diffs` component should be correctly loaded in the application.
