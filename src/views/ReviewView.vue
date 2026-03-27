<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { DiffLineAnnotation, AnnotationSide, SelectedLineRange } from "@pierre/diffs";
import { useRouter } from "vue-router";
import { useReviewStore } from "../store";
import PierreDiff from "../components/PierreDiff.vue";
import FileTreeItem from "../components/FileTreeItem.vue";
import type { FileNode } from "../components/FileTreeItem.vue";
import { parsePatchFiles } from "@pierre/diffs";
import ignore from "ignore";

const router = useRouter();
const store = useReviewStore();

const viewMode = ref<"split" | "unified">("split");
const showAllFiles = ref(false);
const showOnlyMyFiles = ref(false);
const wordWrap = ref(true);
const useTreeView = ref(true);

const isSubmitting = ref(false);

// Inline comment state
const inlineCommentLine = ref<{ lineNumber: number; side: AnnotationSide } | null>(null);

// Track annotation version to force re-renders
const annotationVersion = ref(0);

if (!store.mrData) {
  router.push("/");
}

const modifiedFiles = computed(() => store.diffs.map((d) => d.new_path));

const displayedFiles = computed(() => {
  let files = modifiedFiles.value;

  if (
    showOnlyMyFiles.value &&
    store.currentUser &&
    store.codeownersRules.length > 0
  ) {
    const myUsername = `@${store.currentUser.username}`;

    files = files.filter((filePath) => {
      // Find the last matching rule in CODEOWNERS (last match wins in GitLab)
      let isOwner = false;
      for (let i = store.codeownersRules.length - 1; i >= 0; i--) {
        const rule = store.codeownersRules[i];

        // Simple pattern matching using 'ignore' library
        const ig = ignore().add(rule.pattern);
        if (ig.ignores(filePath)) {
          isOwner = rule.owners.includes(myUsername);
          break; // Found the matching rule
        }
      }
      return isOwner;
    });
  }

  return files;
});

const fileTree = computed(() => {
  const root: FileNode = { name: 'root', path: '', isDir: true, children: {} };
  for (const filePath of displayedFiles.value) {
    const parts = filePath.split('/');
    let current = root;
    let currentPath = '';
    
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        
        if (!current.children![part]) {
            current.children![part] = {
                name: part,
                path: currentPath,
                isDir: i < parts.length - 1,
                children: i < parts.length - 1 ? {} : undefined,
            };
        }
        current = current.children![part];
    }
  }
  return root;
});

const file = computed(() => {
  if (!store.selectedFile) return null;
  return store.diffs.find((d) => d.new_path === store.selectedFile) || null;
});

const parsedFileDiff = computed(() => {
  if (!file.value || !file.value.diff) return null;
  const f = file.value;
  let patch = `diff --git a/${f.old_path} b/${f.new_path}\n`;
  
  if (f.new_file) patch += `new file mode 100644\n`;
  if (f.deleted_file) patch += `deleted file mode 100644\n`;
  
  if (f.new_file) {
    patch += `--- /dev/null\n`;
  } else {
    patch += `--- a/${f.old_path}\n`;
  }
  
  if (f.deleted_file) {
    patch += `+++ /dev/null\n`;
  } else {
    patch += `+++ b/${f.new_path}\n`;
  }
  
  patch += f.diff;
  
  try {
    const parsed = parsePatchFiles(patch);
    return parsed[0]?.files[0] || null;
  } catch (e) {
    console.error("Failed to parse diff", e);
    return null;
  }
});

const selectFile = (path: string) => {
  store.selectFile(path);
  inlineCommentLine.value = null;
};

const markAsViewed = () => {
  if (store.selectedFile) {
    store.markFileAsViewed(store.selectedFile);
    const unviewed = modifiedFiles.value.filter(
      (f) => !store.viewedFiles.has(f),
    );
    if (unviewed.length > 0) {
      store.selectFile(unviewed[0]);
    }
  }
};

// --- Inline comment helpers ---

const createCommentData = (body: string, lineNumber: number) => {
  const f = store.diffs.find((d) => d.new_path === store.selectedFile);
  if (!f) return null;

  const base: any = {
    id: Date.now().toString(),
    body,
    new_path: f.new_path,
    old_path: f.old_path,
    new_line: lineNumber,
  };

  if (store.platform === 'gitlab') {
    base.base_sha = store.mrData.latestVersion.base_commit_sha;
    base.head_sha = store.mrData.latestVersion.head_commit_sha;
    base.start_sha = store.mrData.latestVersion.start_commit_sha;
  } else {
    base.commit_id = store.mrData.headSha;
  }

  return base;
};

const postComment = async (commentData: any) => {
  if (store.platform === 'gitlab') {
    const pat = localStorage.getItem("gitlab_pat");
    const formData = new FormData();
    formData.append("position[position_type]", "text");
    formData.append("position[base_sha]", commentData.base_sha);
    formData.append("position[head_sha]", commentData.head_sha);
    formData.append("position[start_sha]", commentData.start_sha);
    formData.append("position[new_path]", commentData.new_path);
    formData.append("position[old_path]", commentData.old_path);
    formData.append("position[new_line]", commentData.new_line.toString());
    formData.append("body", commentData.body);

    const res = await fetch(
      `${store.mrData.host}/api/v4/projects/${store.mrData.encodedProjectPath}/merge_requests/${store.mrData.mrIid}/discussions`,
      {
        method: "POST",
        headers: { "PRIVATE-TOKEN": pat! },
        body: formData,
      },
    );
    if (!res.ok) throw new Error("Failed to post comment");
  } else {
    const pat = localStorage.getItem("github_pat");
    const { owner, repo, prNumber } = store.mrData;

    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${pat}`,
          "Accept": "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          body: commentData.body,
          commit_id: commentData.commit_id,
          path: commentData.new_path,
          line: commentData.new_line,
          side: "RIGHT",
        }),
      },
    );
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.message || "Failed to post comment");
    }
  }
};

const sendBatchComments = async () => {
  if (store.batchedComments.length === 0) return;
  isSubmitting.value = true;

  try {
    for (const comment of store.batchedComments) {
      await postComment(comment);
    }
    // Move sent comments to remote so they display as posted
    for (const comment of store.batchedComments) {
      store.remoteComments.push({
        ...comment,
        author: store.currentUser?.username || store.currentUser?.name || 'You',
        created_at: new Date().toISOString(),
      });
    }
    store.clearBatchedComments();
    annotationVersion.value++;
    alert("All batched comments sent!");
  } catch (err) {
    alert(`Error sending batch: ${(err as Error).message}`);
  } finally {
    isSubmitting.value = false;
  }
};

// --- Annotation rendering ---

const createInlineEditorElement = (lineNumber: number, side: AnnotationSide): HTMLElement => {
  const wrapper = document.createElement('div');
  wrapper.className = 'inline-comment-editor';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Write a comment...';
  textarea.rows = 3;
  wrapper.appendChild(textarea);

  const actions = document.createElement('div');
  actions.className = 'inline-comment-actions';

  const batchBtn = document.createElement('button');
  batchBtn.className = 'inline-btn inline-btn-secondary';
  batchBtn.textContent = 'Add to Batch';
  batchBtn.addEventListener('click', () => {
    const body = textarea.value.trim();
    if (!body) return;
    const data = createCommentData(body, lineNumber);
    if (data) {
      store.addBatchedComment(data);
      inlineCommentLine.value = null;
      annotationVersion.value++;
    }
  });

  const sendBtn = document.createElement('button');
  sendBtn.className = 'inline-btn inline-btn-primary';
  sendBtn.textContent = 'Send Now';
  sendBtn.addEventListener('click', async () => {
    const body = textarea.value.trim();
    if (!body) return;
    const data = createCommentData(body, lineNumber);
    if (data) {
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending...';
      try {
        await postComment(data);
        // Add to remote comments so it shows as a posted comment
        store.remoteComments.push({
          ...data,
          author: store.currentUser?.username || store.currentUser?.name || 'You',
          created_at: new Date().toISOString(),
        });
        inlineCommentLine.value = null;
        annotationVersion.value++;
      } catch (err) {
        alert(`Error: ${(err as Error).message}`);
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Now';
      }
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'inline-btn inline-btn-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    inlineCommentLine.value = null;
    annotationVersion.value++;
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(batchBtn);
  actions.appendChild(sendBtn);
  wrapper.appendChild(actions);

  // Auto-focus the textarea after it's in the DOM
  requestAnimationFrame(() => textarea.focus());

  return wrapper;
};

const createCommentBubbleElement = (comment: any): HTMLElement => {
  const wrapper = document.createElement('div');
  wrapper.className = 'inline-comment-bubble';

  const body = document.createElement('div');
  body.className = 'inline-comment-body';
  body.textContent = comment.body;
  wrapper.appendChild(body);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'inline-comment-remove';
  removeBtn.textContent = '✕';
  removeBtn.title = 'Remove from batch';
  removeBtn.addEventListener('click', () => {
    store.removeBatchedComment(comment.id);
    annotationVersion.value++;
  });
  wrapper.appendChild(removeBtn);

  return wrapper;
};

const createRemoteCommentElement = (comment: any): HTMLElement => {
  const wrapper = document.createElement('div');
  wrapper.className = 'inline-comment-remote';

  const header = document.createElement('div');
  header.className = 'inline-comment-remote-header';
  header.textContent = comment.author;
  wrapper.appendChild(header);

  const body = document.createElement('div');
  body.className = 'inline-comment-remote-body';
  body.textContent = comment.body;
  wrapper.appendChild(body);

  return wrapper;
};

// --- Diff options with gutter utility ---

const diffOptions = computed(() => ({
  diffStyle: viewMode.value ?? 'split',
  overflow: wordWrap.value ? 'wrap' as const : 'scroll' as const,
  enableGutterUtility: true,
  renderGutterUtility: (getHoveredRow: () => { lineNumber: number; side: AnnotationSide } | undefined) => {
    const btn = document.createElement('button');
    btn.className = 'gutter-plus-btn';
    btn.textContent = '+';
    btn.title = 'Add a comment';
    btn.addEventListener('click', () => {
      const hovered = getHoveredRow();
      if (hovered) {
        inlineCommentLine.value = {
          lineNumber: hovered.lineNumber,
          side: hovered.side ?? 'additions',
        };
        annotationVersion.value++;
      }
    });
    return btn;
  },
  renderAnnotation: (annotation: DiffLineAnnotation<any>) => {
    const meta = annotation.metadata;
    if (!meta) return undefined;
    if (meta.type === 'editor') {
      return createInlineEditorElement(annotation.lineNumber, annotation.side);
    }
    if (meta.type === 'comment') {
      return createCommentBubbleElement(meta.comment);
    }
    if (meta.type === 'remote') {
      return createRemoteCommentElement(meta.comment);
    }
    return undefined;
  },
}));

// --- Line annotations computed ---

const lineAnnotations = computed(() => {
  // Force reactivity on annotationVersion
  void annotationVersion.value;

  const annotations: DiffLineAnnotation<any>[] = [];

  // Add batched comments for current file as annotations
  const currentFileComments = store.batchedComments.filter(
    (c) => c.new_path === store.selectedFile
  );
  for (const comment of currentFileComments) {
    annotations.push({
      lineNumber: comment.new_line,
      side: 'additions' as AnnotationSide,
      metadata: { type: 'comment', comment },
    });
  }

  // Add remote comments for current file as annotations
  const currentFileRemoteComments = store.remoteComments.filter(
    (c) => c.new_path === store.selectedFile
  );
  for (const comment of currentFileRemoteComments) {
    annotations.push({
      lineNumber: comment.new_line,
      side: 'additions' as AnnotationSide,
      metadata: { type: 'remote', comment },
    });
  }

  // Add the active inline editor as an annotation
  if (inlineCommentLine.value) {
    annotations.push({
      lineNumber: inlineCommentLine.value.lineNumber,
      side: inlineCommentLine.value.side,
      metadata: { type: 'editor' },
    });
  }

  return annotations;
});

</script>

<template>
  <div class="review-container">
    <div class="sidebar">
      <div class="sidebar-header">
        <h3>Files</h3>
        <div class="toggles">
          <label class="toggle">
            <input type="checkbox" v-model="showAllFiles" />
            Show all files
          </label>
          <label class="toggle" v-if="store.codeownersRules.length > 0">
            <input type="checkbox" v-model="showOnlyMyFiles" />
            Only my files (CODEOWNERS)
          </label>
          <label class="toggle">
            <input type="checkbox" v-model="useTreeView" />
            Tree view
          </label>
        </div>
      </div>

      <ul class="file-list" v-if="!useTreeView">
        <li
          v-for="file in displayedFiles"
          :key="file"
          :class="{
            active: store.selectedFile === file,
            viewed: store.viewedFiles.has(file),
          }"
          @click="selectFile(file)"
        >
          <span class="status-dot"></span>
          {{ file.split("/").pop() }}
        </li>
      </ul>
      <div class="file-tree" v-else>
        <FileTreeItem
          :node="fileTree"
          :selectedFile="store.selectedFile"
          :viewedFiles="store.viewedFiles"
          @select="selectFile"
        />
      </div>

      <div class="batch-panel" v-if="store.batchedComments.length > 0">
        <h3>Batched Comments ({{ store.batchedComments.length }})</h3>
        <ul class="batch-list">
          <li v-for="c in store.batchedComments" :key="c.id">
            Line {{ c.new_line }}: {{ c.body.substring(0, 20) }}...
            <button @click="store.removeBatchedComment(c.id)">X</button>
          </li>
        </ul>
        <button
          class="btn-primary"
          @click="sendBatchComments"
          :disabled="isSubmitting"
        >
          Send All
        </button>
      </div>
    </div>

    <div class="main-content">
      <div class="toolbar">
        <div class="view-toggles">
          <button
            :class="{ active: viewMode === 'split' }"
            @click="viewMode = 'split'"
          >
            Split
          </button>
          <button
            :class="{ active: viewMode === 'unified' }"
            @click="viewMode = 'unified'"
          >
            Unified
          </button>
          <button
            :class="{ active: wordWrap }"
            @click="wordWrap = !wordWrap"
          >
            Wrap Words
          </button>
        </div>
        <div class="actions">
          <button class="btn-primary" @click="markAsViewed">
            Mark as Viewed
          </button>
        </div>
      </div>

      <div class="diff-area">
        <PierreDiff
          v-if="parsedFileDiff"
          :fileDiff="parsedFileDiff"
          :options="diffOptions"
          :lineAnnotations="lineAnnotations"
        />
        <div v-else-if="file && !file.diff" class="empty-state">No differences (e.g. binary file or only empty lines)</div>
        <div v-else class="empty-state">Select a file to review</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.review-container {
  display: flex;
  height: 100%;
  width: 100%;
  background: #1e1e1e;
  color: #ccc;
}
.sidebar {
  width: 300px;
  border-right: 1px solid #333;
  display: flex;
  flex-direction: column;
  background: #252526;
}
.sidebar-header {
  padding: 1rem;
  border-bottom: 1px solid #333;
}
.sidebar-header h3 {
  margin: 0 0 0.5rem 0;
}
.toggles {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.toggle {
  font-size: 0.8rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
}
.file-list {
  list-style: none;
  padding: 0;
  margin: 0;
  overflow-y: auto;
  flex: 1;
}
.file-tree {
  overflow-y: auto;
  flex: 1;
}
.file-list li {
  padding: 0.5rem 1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  border-bottom: 1px solid #2d2d2d;
  font-size: 0.9rem;
  word-break: break-all;
}
.file-list li:hover {
  background: #2a2d2e;
}
.file-list li.active {
  background: #37373d;
  color: #fff;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ffb000;
  margin-right: 8px;
  flex-shrink: 0;
}
.file-list li.viewed .status-dot {
  background: #4caf50;
}

.batch-panel {
  padding: 1rem;
  border-top: 1px solid #333;
  background: #1e1e1e;
}
.batch-list {
  list-style: none;
  padding: 0;
  margin: 0 0 1rem 0;
  font-size: 0.85rem;
}
.batch-list li {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}
.batch-list button {
  background: transparent;
  border: none;
  color: #ff4444;
  cursor: pointer;
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0; /* Important for flex children to allow shrink */
}
.toolbar {
  padding: 0.5rem 1rem;
  background: #252526;
  border-bottom: 1px solid #333;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}
.view-toggles button {
  background: #333;
  color: #ccc;
  border: 1px solid #444;
  padding: 0.25rem 0.75rem;
  cursor: pointer;
}
.view-toggles button.active {
  background: #007bff;
  color: white;
  border-color: #007bff;
}
.view-toggles button:first-child {
  border-radius: 4px 0 0 4px;
}
.view-toggles button:last-child {
  border-radius: 0 4px 4px 0;
}
.btn-primary {
  background: #4caf50;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
}
.btn-primary:hover {
  background: #45a049;
}
.btn-primary:disabled {
  background: #555;
}
.btn-secondary {
  background: #333;
  color: white;
  border: 1px solid #555;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
}

.diff-area {
  flex: 1;
  overflow-y: auto; /* Scroll diff content vertically */
  padding: 0;
  background: #1e1e1e;
  display: block; /* Allows content naturally expand block boundaries to be scrolled */
}
.empty-state {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  color: #666;
}

</style>

<style>
/* Gutter "+" button — unscoped so it applies inside the pierre DOM */
.gutter-plus-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: none;
  background: #238636;
  color: white;
  font-size: 14px;
  font-weight: bold;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
.gutter-plus-btn:hover {
  background: #2ea043;
}

/* Inline editor */
.inline-comment-editor {
  padding: 12px 16px;
  background: #1c2128;
  border: 1px solid #444c56;
  border-radius: 6px;
  margin: 4px 8px;
}
.inline-comment-editor textarea {
  width: 100%;
  background: #0d1117;
  color: #e6edf3;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 8px;
  font-family: inherit;
  font-size: 0.85rem;
  resize: vertical;
  box-sizing: border-box;
}
.inline-comment-editor textarea:focus {
  outline: none;
  border-color: #58a6ff;
}
.inline-comment-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
}
.inline-btn {
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid transparent;
  font-size: 0.8rem;
  cursor: pointer;
  font-weight: 500;
}
.inline-btn-primary {
  background: #238636;
  color: white;
}
.inline-btn-primary:hover {
  background: #2ea043;
}
.inline-btn-primary:disabled {
  background: #555;
  cursor: not-allowed;
}
.inline-btn-secondary {
  background: #21262d;
  color: #c9d1d9;
  border-color: #30363d;
}
.inline-btn-secondary:hover {
  background: #30363d;
}
.inline-btn-cancel {
  background: transparent;
  color: #8b949e;
}
.inline-btn-cancel:hover {
  color: #c9d1d9;
}

/* Batched comment bubble */
.inline-comment-bubble {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  margin: 4px 8px;
  background: #1c2128;
  border: 1px solid #30363d;
  border-radius: 6px;
  color: #c9d1d9;
  font-size: 0.85rem;
}
.inline-comment-body {
  flex: 1;
}
.inline-comment-remove {
  background: none;
  border: none;
  color: #8b949e;
  cursor: pointer;
  font-size: 0.9rem;
  padding: 2px 6px;
  border-radius: 4px;
}
.inline-comment-remove:hover {
  color: #f85149;
  background: rgba(248, 81, 73, 0.1);
}

/* Remote (existing) comments */
.inline-comment-remote {
  padding: 8px 16px;
  margin: 4px 8px;
  background: #161b22;
  border: 1px solid #30363d;
  border-left: 3px solid #58a6ff;
  border-radius: 6px;
  font-size: 0.85rem;
}
.inline-comment-remote-header {
  font-weight: 600;
  color: #58a6ff;
  margin-bottom: 4px;
  font-size: 0.8rem;
}
.inline-comment-remote-body {
  color: #c9d1d9;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
