<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useReviewStore } from '../store';
import PierreDiff from '../components/PierreDiff.vue';
import ignore from 'ignore';

const router = useRouter();
const store = useReviewStore();

const viewMode = ref<'split' | 'inline'>('split');
const showAllFiles = ref(false);
const showOnlyMyFiles = ref(false);

const commentLine = ref('');
const commentBody = ref('');
const isSubmitting = ref(false);

if (!store.mrData) {
  router.push('/');
}

const modifiedFiles = computed(() => store.diffs.map(d => d.new_path));

const displayedFiles = computed(() => {
  let files = modifiedFiles.value;

  if (showOnlyMyFiles.value && store.currentUser && store.codeownersRules.length > 0) {
    const myUsername = `@${store.currentUser.username}`;
    
    files = files.filter(filePath => {
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

const currentDiff = computed(() => {
  if (!store.selectedFile) return null;
  const file = store.diffs.find(d => d.new_path === store.selectedFile);
  if (!file) return null;
  
  return `--- a/${file.old_path}\n+++ b/${file.new_path}\n${file.diff}`;
});

const selectFile = (path: string) => {
  store.selectFile(path);
};

const markAsViewed = () => {
  if (store.selectedFile) {
    store.markFileAsViewed(store.selectedFile);
    const unviewed = modifiedFiles.value.filter(f => !store.viewedFiles.has(f));
    if (unviewed.length > 0) {
      store.selectFile(unviewed[0]);
    }
  }
};

const postComment = async (instant: boolean) => {
  if (!commentBody.value || !commentLine.value || !store.selectedFile) return;

  const file = store.diffs.find(d => d.new_path === store.selectedFile);
  if (!file) return;

  const commentData = {
    id: Date.now().toString(),
    body: commentBody.value,
    new_path: file.new_path,
    old_path: file.old_path,
    new_line: parseInt(commentLine.value, 10),
    base_sha: store.mrData.latestVersion.base_commit_sha,
    head_sha: store.mrData.latestVersion.head_commit_sha,
    start_sha: store.mrData.latestVersion.start_commit_sha,
  };

  if (instant) {
    isSubmitting.value = true;
    try {
      const pat = localStorage.getItem('gitlab_pat');
      const formData = new FormData();
      formData.append('position[position_type]', 'text');
      formData.append('position[base_sha]', commentData.base_sha);
      formData.append('position[head_sha]', commentData.head_sha);
      formData.append('position[start_sha]', commentData.start_sha);
      formData.append('position[new_path]', commentData.new_path);
      formData.append('position[old_path]', commentData.old_path);
      formData.append('position[new_line]', commentData.new_line.toString());
      formData.append('body', commentData.body);

      const res = await fetch(`${store.mrData.host}/api/v4/projects/${store.mrData.encodedProjectPath}/merge_requests/${store.mrData.mrIid}/discussions`, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': pat! },
        body: formData
      });

      if (!res.ok) throw new Error('Failed to post comment');
      commentBody.value = '';
      commentLine.value = '';
      alert('Comment posted!');
    } catch (err) {
      alert(`Error: ${(err as Error).message}`);
    } finally {
      isSubmitting.value = false;
    }
  } else {
    store.addBatchedComment(commentData);
    commentBody.value = '';
    commentLine.value = '';
  }
};

const sendBatchComments = async () => {
  if (store.batchedComments.length === 0) return;
  isSubmitting.value = true;
  const pat = localStorage.getItem('gitlab_pat');
  
  try {
    for (const comment of store.batchedComments) {
      const formData = new FormData();
      formData.append('position[position_type]', 'text');
      formData.append('position[base_sha]', comment.base_sha);
      formData.append('position[head_sha]', comment.head_sha);
      formData.append('position[start_sha]', comment.start_sha);
      formData.append('position[new_path]', comment.new_path);
      formData.append('position[old_path]', comment.old_path);
      formData.append('position[new_line]', comment.new_line.toString());
      formData.append('body', comment.body);

      await fetch(`${store.mrData.host}/api/v4/projects/${store.mrData.encodedProjectPath}/merge_requests/${store.mrData.mrIid}/discussions`, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': pat! },
        body: formData
      });
    }
    store.clearBatchedComments();
    alert('All batched comments sent!');
  } catch (err) {
    alert(`Error sending batch: ${(err as Error).message}`);
  } finally {
    isSubmitting.value = false;
  }
};
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
        </div>
      </div>
      
      <ul class="file-list">
        <li v-for="file in displayedFiles" :key="file" 
            :class="{ active: store.selectedFile === file, viewed: store.viewedFiles.has(file) }"
            @click="selectFile(file)">
          <span class="status-dot"></span>
          {{ file.split('/').pop() }}
        </li>
      </ul>

      <div class="batch-panel" v-if="store.batchedComments.length > 0">
        <h3>Batched Comments ({{ store.batchedComments.length }})</h3>
        <ul class="batch-list">
          <li v-for="c in store.batchedComments" :key="c.id">
            Line {{ c.new_line }}: {{ c.body.substring(0, 20) }}...
            <button @click="store.removeBatchedComment(c.id)">X</button>
          </li>
        </ul>
        <button class="btn-primary" @click="sendBatchComments" :disabled="isSubmitting">Send All</button>
      </div>
    </div>
    
    <div class="main-content">
      <div class="toolbar">
        <div class="view-toggles">
          <button :class="{ active: viewMode === 'split' }" @click="viewMode = 'split'">Split</button>
          <button :class="{ active: viewMode === 'inline' }" @click="viewMode = 'inline'">Inline</button>
        </div>
        <div class="actions">
          <button class="btn-primary" @click="markAsViewed">Mark as Viewed</button>
        </div>
      </div>
      
      <div class="diff-area">
        <PierreDiff v-if="currentDiff" :diffString="currentDiff" :viewMode="viewMode" />
        <div v-else class="empty-state">
          Select a file to review
        </div>
      </div>

      <div class="comment-panel" v-if="store.selectedFile">
        <h4>Add Comment to {{ store.selectedFile.split('/').pop() }}</h4>
        <div class="form-row">
          <input type="number" v-model="commentLine" placeholder="Line number..." class="input-line" />
          <input type="text" v-model="commentBody" placeholder="Write a comment..." class="input-body" />
        </div>
        <div class="form-actions">
          <button class="btn-secondary" @click="postComment(false)" :disabled="!commentBody || !commentLine">Add to Batch</button>
          <button class="btn-primary" @click="postComment(true)" :disabled="isSubmitting || !commentBody || !commentLine">Send Instantly</button>
        </div>
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
  overflow: hidden; /* Changed from auto, the child PierreDiff handles its own scroll or we wrap it correctly */
  padding: 0; /* Remove padding for true full-width diffs */
  background: #1e1e1e;
  display: flex;
}
.empty-state {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  color: #666;
}

.comment-panel {
  padding: 1rem;
  background: #252526;
  border-top: 1px solid #333;
}
.comment-panel h4 {
  margin: 0 0 0.5rem 0;
  font-size: 0.9rem;
}
.form-row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.input-line {
  width: 100px;
  background: #1e1e1e;
  border: 1px solid #444;
  color: white;
  padding: 0.5rem;
}
.input-body {
  flex: 1;
  background: #1e1e1e;
  border: 1px solid #444;
  color: white;
  padding: 0.5rem;
}
.form-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}
</style>