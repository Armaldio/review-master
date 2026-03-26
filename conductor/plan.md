# Code Review Application Implementation Plan

## Objective
Develop a local Code Review application utilizing Electron, Vue 3 (Composition API), and `@pierre/diffs` for reviewing GitLab Merge Requests, featuring local cloning, specialized diff visualization, fluid navigation, and batched/instant commenting.

## Scope & Requirements
- **Strict Tech Stack:** TypeScript, Vue 3 (Composition API, `script setup`), Electron, `@pierre/diffs`.
- **Settings View:** Store and manage GitLab Personal Access Token (PAT).
- **Initialization:** Input GitLab MR ID/URL -> Main process clones repository locally.
- **Review Interface:** File tree view (toggle between all files and modified MR files).
- **Code Visualization:** Use `@pierre/diffs` for rendering split (side-by-side) and inline diffs.
- **Navigation:** "Mark as viewed" functionality that automatically focuses the next file.
- **Commenting System:** 
  - Instant mode: Post directly to the MR.
  - Batch mode: Draft comments locally, edit/delete, and publish all at once.

## Implementation Steps

### Phase 1: Setup and Architecture
1. **Dependencies:** Install `vue`, `vue-router`, `pinia`, `@vitejs/plugin-vue`, `simple-git`, and `@pierre/diffs`.
2. **Vite Configuration:** Update `vite.renderer.config.ts` to include the Vue plugin.
3. **Application Entry:** Setup Vue application in `src/renderer.ts` and create `src/App.vue`.
4. **State Management:** Implement Pinia stores for:
   - **Settings:** PAT, user preferences.
   - **Review State:** Current MR data, modified files list, viewed status, drafted batch comments.

### Phase 2: Main Process & IPC (Electron)
1. **Local Cloning Service:** Add IPC handlers in `src/main.ts` using `simple-git` to clone the target repository into a designated local configuration/appData folder based on the MR URL.
2. **Preload Script:** Expose safe APIs in `src/preload.ts` (`window.electronAPI.cloneRepo`, `window.electronAPI.getConfigPath`, etc.).

### Phase 3: GitLab API Integration
1. **API Service:** Create a frontend service (using native `fetch`) to interact with GitLab:
   - Fetch MR details and versions (`/projects/:id/merge_requests/:iid/versions`) to get `base_sha`, `head_sha`, and `start_sha`.
   - Fetch MR diffs (`/projects/:id/merge_requests/:iid/diffs`).
   - Post discussions/comments (`/projects/:id/merge_requests/:iid/discussions`).

### Phase 4: UI Development & `@pierre/diffs` Integration
1. **Settings View:** Simple form to input and persist the GitLab PAT (using `localStorage` or `electron-store`).
2. **Initialization View:** Form to input MR URL, triggering the Electron clone process and fetching MR data.
3. **Review Workspace:**
   - **File Tree Sidebar:** Render files recursively. Add a toggle (All Files vs. Modified Files). Implement "Mark as Viewed" logic that auto-selects the next pending file from the store.
   - **Diff Viewer Component:** Create a Vue wrapper for the `@pierre/diffs` Vanilla JS API. 
     - Initialize `WorkerPoolManager` singleton.
     - Mount the `<file-diff>` custom element within a Vue template ref.
     - Provide UI toggles for `split` and `inline` rendering options.
4. **Commenting UI:**
   - Integrate with the `@pierre/diffs` line selection/click events (or overlay) to spawn a comment box.
   - Provide "Send Now" (Instant) and "Add to Batch" actions.
   - Create a sliding/floating panel to review, edit, delete, and flush batched comments.

## Verification & Testing
- Ensure the Vue app launches without Vite/Electron errors.
- Validate the PAT saves and authenticates correctly against the GitLab API.
- Test the cloning process (verify files exist in local AppData).
- Test `@pierre/diffs` shadow DOM rendering and theme integration in Vue.
- Verify "Mark as viewed" correctly focuses the next file in the list.
- Post test comments to a dummy MR in both instant and batched modes.