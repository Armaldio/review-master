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
import { marked } from "marked";
import DOMPurify from "dompurify";

const router = useRouter();
const store = useReviewStore();

const viewMode = ref<"split" | "unified">("split");
const showAllFiles = ref(false);
const showOnlyMyFiles = ref(false);
const wordWrap = ref(true);
const useTreeView = ref(true);

const isSubmitting = ref(false);

// Inline comment state
const inlineCommentLocation = ref<{ 
  lineNumber: number; 
  side: AnnotationSide;
  range?: SelectedLineRange;
} | null>(null);

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
  const root: FileNode = { name: 'root', path: '', isDir: true, children: {}, commentCount: 0 };
  
  // 1. Map each file to its comment counts
  const countsByFile: Record<string, number> = {};
  for (const c of store.remoteComments) {
    countsByFile[c.new_path] = (countsByFile[c.new_path] || 0) + 1;
  }
  for (const c of store.batchedComments) {
    countsByFile[c.new_path] = (countsByFile[c.new_path] || 0) + 1;
  }

  // 2. Build the tree structure
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
                commentCount: 0
            };
        }
        current = current.children![part];
        if (i === parts.length - 1) {
            current.commentCount = countsByFile[filePath] || 0;
        }
    }
  }

  // 3. Roll up counts for directories
  const rollout = (node: FileNode): number => {
    if (!node.isDir) return node.commentCount || 0;
    
    let total = 0;
    if (node.children) {
        for (const childName in node.children) {
            total += rollout(node.children[childName]);
        }
    }
    node.commentCount = total;
    return total;
  };

  rollout(root);

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

const TRASH_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 6h18"></path>
  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
  <line x1="10" y1="11" x2="10" y2="17"></line>
  <line x1="14" y1="11" x2="14" y2="17"></line>
</svg>
`;

const selectFile = (path: string) => {
  store.selectFile(path);
  inlineCommentLocation.value = null;
};

// --- Emoji Support ---

const COMMON_EMOJIS = [
    { char: '👍', github: 'plus_one', gitlab: 'thumbsup' },
    { char: '👎', github: 'minus_one', gitlab: 'thumbsdown' },
    { char: '😄', github: 'laugh', gitlab: 'smile' },
    { char: '🎉', github: 'hooray', gitlab: 'tada' },
    { char: '❤️', github: 'heart', gitlab: 'heart' },
    { char: '🚀', github: 'rocket', gitlab: 'rocket' },
    { char: '👀', github: 'eyes', gitlab: 'eyes' },
    { char: '😕', github: 'confused', gitlab: 'confused' },
];

const createEmojiPicker = (onSelect: (emoji: string) => void): HTMLElement => {
    const container = document.createElement('div');
    container.className = 'emoji-picker-container';

    const btn = document.createElement('button');
    btn.className = 'emoji-picker-btn';
    btn.textContent = '😀';
    btn.type = 'button';
    container.appendChild(btn);

    const popup = document.createElement('div');
    popup.className = 'emoji-popup';
    popup.style.display = 'none';

    COMMON_EMOJIS.forEach(emoji => {
        const item = document.createElement('button');
        item.className = 'emoji-item';
        item.textContent = emoji.char;
        item.type = 'button';
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            onSelect(emoji.char);
            popup.style.display = 'none';
        });
        popup.appendChild(item);
    });

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        popup.style.display = popup.style.display === 'none' ? 'grid' : 'none';
    });

    document.addEventListener('click', () => {
        popup.style.display = 'none';
    });

    container.appendChild(popup);
    return container;
};

const addReaction = async (comment: any, emojiChar: string) => {
    if (!store.activeProvider) return;
    const emoji = COMMON_EMOJIS.find(e => e.char === emojiChar);
    if (!emoji) return;

    try {
        const platformEmoji = store.platform === 'github' ? emoji.github : emoji.gitlab;
        await store.activeProvider.addReaction(comment.id, platformEmoji);

        // Optimistically update UI
        if (!comment.reactions) comment.reactions = [];
        const existing = comment.reactions.find((r: any) => r.name === emojiChar);
        if (existing) {
            existing.count++;
        } else {
            comment.reactions.push({ name: emojiChar, count: 1 });
        }
        annotationVersion.value++;
    } catch (err) {
        alert(`Reaction error: ${(err as Error).message}`);
    }
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

const createCommentData = (body: string, lineNumber: number, range?: any) => {
  const f = store.diffs.find((d) => d.new_path === store.selectedFile);
  if (!f) return null;

  return {
    id: Date.now().toString(),
    body,
    new_path: f.new_path,
    old_path: f.old_path,
    new_line: lineNumber,
    range: range // Store for local display
  };
};

const postComment = async (commentData: any) => {
  if (!store.activeProvider) return;
  return await store.activeProvider.postComment(commentData);
};

const postReply = async (threadComment: any, body: string) => {
  if (!store.activeProvider) return;
  return await store.activeProvider.postReply(threadComment, body);
};

const deleteRemoteComment = async (comment: any) => {
  if (!store.activeProvider) return;
  const confirmed = confirm("Are you sure you want to delete this comment? This action cannot be undone.");
  if (!confirmed) return;

  try {
    await store.activeProvider.deleteComment(comment.id);
    store.removeRemoteComment(comment.id);
    annotationVersion.value++;
  } catch (err) {
    alert(`Error: ${(err as Error).message}`);
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
        avatar_url: store.currentUser?.avatar_url, // Ensure avatar is shown immediately
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

  const picker = createEmojiPicker((emoji) => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    textarea.value = text.substring(0, start) + emoji + text.substring(end);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
  });
  actions.appendChild(picker);

  const rightActions = document.createElement('div');
  rightActions.style.display = 'flex';
  rightActions.style.gap = '8px';
  actions.appendChild(rightActions);

  const batchBtn = document.createElement('button');
  batchBtn.className = 'inline-btn inline-btn-secondary';
  batchBtn.textContent = 'Add to Batch';
  batchBtn.addEventListener('click', () => {
    const body = textarea.value.trim();
    if (!body) return;
    const data = createCommentData(body, lineNumber, inlineCommentLocation.value?.range);
    if (data) {
      store.addBatchedComment(data);
      inlineCommentLocation.value = null;
      annotationVersion.value++;
    }
  });
  rightActions.appendChild(batchBtn);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'inline-btn inline-btn-primary';
  sendBtn.textContent = 'Send Now';
  sendBtn.addEventListener('click', async () => {
    const body = textarea.value.trim();
    if (!body) return;
    const data = createCommentData(body, lineNumber, inlineCommentLocation.value?.range);
    if (data) {
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending...';
      try {
        await postComment(data);
        // Add to remote comments so it shows as a posted comment
        store.remoteComments.push({
          ...data,
          author: store.currentUser?.username || store.currentUser?.name || 'You',
          avatar_url: store.currentUser?.avatar_url, // Ensure avatar is shown immediately
          created_at: new Date().toISOString(),
        });
        inlineCommentLocation.value = null;
        annotationVersion.value++;
      } catch (err) {
        alert(`Error: ${(err as Error).message}`);
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Now';
      }
    }
  });
  rightActions.appendChild(sendBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'inline-btn inline-btn-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    inlineCommentLocation.value = null;
    annotationVersion.value++;
  });
  rightActions.appendChild(cancelBtn);

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
  enableLineSelection: true,
  onLineSelectionEnd: (range: SelectedLineRange | null) => {
    if (range) {
      inlineCommentLocation.value = {
        lineNumber: range.end,
        side: (range.endSide as AnnotationSide) || 'additions',
        range,
      };
      annotationVersion.value++;
    } else {
      inlineCommentLocation.value = null;
      annotationVersion.value++;
    }
  },
  renderGutterUtility: (getHoveredRow: () => { lineNumber: number; side: AnnotationSide } | undefined) => {
    const btn = document.createElement('button');
    btn.className = 'gutter-plus-btn';
    btn.textContent = '+';
    btn.title = 'Add a comment';
    btn.addEventListener('click', () => {
      const hovered = getHoveredRow();
      if (hovered) {
        inlineCommentLocation.value = {
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
    if (meta.type === 'thread') {
      return createThreadElement(meta.comments);
    }
    return undefined;
  },
}));

const createThreadElement = (comments: any[]): HTMLElement => {
  const container = document.createElement('div');
  container.className = 'comment-thread-container';

  // Group comments by their thread ID (discussion_id for GitLab, or chaining for GitHub)
  // For simplicity here, we display them in chronological order as a single thread
  // since they are already filtered by line number.
  
  comments.forEach((comment, index) => {
    const commentEl = document.createElement('div');
    commentEl.className = 'comment-item';
    if (comment.in_reply_to_id || (index > 0 && comment.discussion_id)) {
        commentEl.classList.add('comment-reply');
    }

    const avatar = document.createElement('img');
    avatar.className = 'comment-avatar';
    avatar.src = comment.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(comment.author)}&background=random`;
    commentEl.appendChild(avatar);

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'comment-content';    const header = document.createElement('div');
    header.className = 'comment-header';
    
    const authorName = document.createElement('span');
    authorName.className = 'comment-author';
    authorName.textContent = comment.author;
    header.appendChild(authorName);

    const time = document.createElement('span');
    time.className = 'comment-time';
    time.textContent = new Date(comment.created_at).toLocaleString();
    header.appendChild(time);

    if (comment.is_batched) {
        const badge = document.createElement('span');
        badge.className = 'comment-badge-batched';
        badge.textContent = 'PENDING';
        header.appendChild(badge);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'comment-remove-btn';
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', () => {
            store.removeBatchedComment(comment.id);
            annotationVersion.value++;
        });
        header.appendChild(removeBtn);
    } else {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'comment-remove-btn';
        deleteBtn.innerHTML = TRASH_ICON;
        deleteBtn.title = 'Delete comment';
        deleteBtn.addEventListener('click', () => deleteRemoteComment(comment));
        header.appendChild(deleteBtn);
    }

    contentWrapper.appendChild(header);

    const body = document.createElement('div');
    body.className = 'comment-body markdown-body';
    // Render markdown and sanitize
    const rawHtml = marked.parse(comment.body) as string;
    body.innerHTML = DOMPurify.sanitize(rawHtml);
    contentWrapper.appendChild(body);

    // Reactions bar
    const reactionRow = document.createElement('div');
    reactionRow.className = 'reaction-bar';
    (comment.reactions || []).forEach((r: any) => {
        const rel = document.createElement('div');
        rel.className = 'reaction-item';
        rel.textContent = `${r.name} ${r.count}`;
        rel.addEventListener('click', () => addReaction(comment, r.name));
        reactionRow.appendChild(rel);
    });
    const addReactBtn = document.createElement('button');
    addReactBtn.className = 'reaction-add-btn';
    addReactBtn.textContent = '+';
    addReactBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Toggle picker popup logic for reactions
        const pickerPopup = createEmojiPicker((emoji) => {
            addReaction(comment, emoji);
        });
        pickerPopup.className = 'emoji-picker-container';
        pickerPopup.style.position = 'absolute';
        pickerPopup.style.bottom = '100%';
        pickerPopup.style.left = '0';
        
        // Slightly hacky: just add it and trigger click
        addReactBtn.parentElement?.appendChild(pickerPopup);
        pickerPopup.querySelector('button')?.click();
    });
    reactionRow.appendChild(addReactBtn);
    contentWrapper.appendChild(reactionRow);

    commentEl.appendChild(contentWrapper);
    container.appendChild(commentEl);
  });

  // Reply Input directly visible at the end of the thread
  const replyWrapper = document.createElement('div');
  replyWrapper.className = 'reply-input-wrapper';

  const replyInput = document.createElement('textarea');
  replyInput.className = 'reply-textarea';
  replyInput.placeholder = 'Write a reply...';
  replyInput.rows = 1;
  replyInput.addEventListener('input', () => {
    replyInput.style.height = 'auto';
    replyInput.style.height = replyInput.scrollHeight + 'px';
  });

  const replyActions = document.createElement('div');
  replyActions.className = 'reply-actions';
  
  const replyEmojiPicker = createEmojiPicker((emoji) => {
    const start = replyInput.selectionStart;
    const end = replyInput.selectionEnd;
    const text = replyInput.value;
    replyInput.value = text.substring(0, start) + emoji + text.substring(end);
    replyInput.focus();
    replyInput.selectionStart = replyInput.selectionEnd = start + emoji.length;
  });
  replyActions.appendChild(replyEmojiPicker);
  
  const sendReplyBtn = document.createElement('button');
  sendReplyBtn.className = 'inline-btn inline-btn-primary';
  sendReplyBtn.textContent = 'Reply';
  sendReplyBtn.addEventListener('click', async () => {
    const body = replyInput.value.trim();
    if (!body) return;

    sendReplyBtn.disabled = true;
    sendReplyBtn.textContent = '...';

    try {
        // We use the first comment of the thread as base for the reply
        const baseComment = comments[0];
        const newComment = await postReply(baseComment, body);
        store.remoteComments.push(newComment);
        annotationVersion.value++;
    } catch (err) {
        alert(`Error: ${(err as Error).message}`);
        sendReplyBtn.disabled = false;
        sendReplyBtn.textContent = 'Reply';
    }
  });

  replyActions.appendChild(sendReplyBtn);
  replyWrapper.appendChild(replyInput);
  replyWrapper.appendChild(replyActions);
  container.appendChild(replyWrapper);

  return container;
};

// --- Line annotations computed ---

const lineAnnotations = computed(() => {
  // Force reactivity on annotationVersion
  void annotationVersion.value;

  const annotations: DiffLineAnnotation<any>[] = [];

  // Group all comments (remote + batched) by line
  const commentsByLine: Record<string, any[]> = {};

  // Batched
  store.batchedComments
    .filter((c) => c.new_path === store.selectedFile)
    .forEach((c) => {
      const key = `${c.new_line}`;
      if (!commentsByLine[key]) commentsByLine[key] = [];
      commentsByLine[key].push({ ...c, is_batched: true });
    });

  // Remote
  store.remoteComments
    .filter((c) => c.new_path === store.selectedFile)
    .forEach((c) => {
      const key = `${c.new_line}`;
      if (!commentsByLine[key]) commentsByLine[key] = [];
      commentsByLine[key].push(c);
    });

  // Create thread annotations
  for (const [line, comments] of Object.entries(commentsByLine)) {
    annotations.push({
      lineNumber: parseInt(line),
      side: 'additions' as AnnotationSide,
      metadata: { type: 'thread', comments },
    });
  }

  // Add the active inline editor as an annotation
  if (inlineCommentLocation.value) {
    annotations.push({
      lineNumber: inlineCommentLocation.value.lineNumber,
      side: inlineCommentLocation.value.side,
      metadata: { type: 'editor' },
      range: inlineCommentLocation.value.range,
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

/* Comment Threading & Styling */
.comment-thread-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 16px;
  margin: 4px 8px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
}
.comment-item {
  display: flex;
  gap: 12px;
  padding: 8px 0;
}
.comment-item:not(:last-child) {
  border-bottom: 1px solid #21262d;
}
.comment-reply {
  margin-left: 24px;
  border-left: 2px solid #30363d;
  padding-left: 12px;
}
.comment-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #30363d;
  flex-shrink: 0;
}
.comment-content {
  flex: 1;
  min-width: 0;
}
.comment-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.comment-author {
  font-weight: 600;
  color: #c9d1d9;
  font-size: 0.85rem;
}
.comment-time {
  font-size: 0.75rem;
  color: #8b949e;
}
.comment-badge-batched {
  font-size: 0.65rem;
  background: #b67501;
  color: #fff;
  padding: 1px 4px;
  border-radius: 4px;
  font-weight: bold;
}
.comment-remove-btn {
  background: none;
  border: none;
  color: #8b949e;
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0 4px;
}
.comment-remove-btn svg {
  vertical-align: middle;
}
.comment-remove-btn:hover {
  color: #f85149;
}

/* Reply Input Styling */
.reply-input-wrapper {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #30363d;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.reply-textarea {
  width: 100%;
  background: #0d1117;
  color: #e6edf3;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 8px;
  font-family: inherit;
  font-size: 0.85rem;
  resize: none;
  overflow: hidden;
  min-height: 36px;
  box-sizing: border-box;
}
.reply-textarea:focus {
  outline: none;
  border-color: #58a6ff;
}
.reply-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* Emoji Picker & Reactions */
.emoji-picker-container {
  position: relative;
  display: inline-block;
}
.emoji-picker-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1.1rem;
  padding: 4px;
  border-radius: 4px;
  transition: background 0.2s;
}
.emoji-picker-btn:hover {
  background: #30363d;
}
.emoji-popup {
  position: absolute;
  bottom: 100%;
  left: 0;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 8px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  z-index: 1000;
  margin-bottom: 8px;
}
.emoji-item {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1.2rem;
  padding: 4px;
  border-radius: 4px;
}
.emoji-item:hover {
  background: #30363d;
}

.reaction-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  padding-top: 4px;
}
.reaction-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 20px;
  padding: 2px 8px;
  font-size: 0.75rem;
  color: #8b949e;
  cursor: pointer;
  transition: all 0.2s;
}
.reaction-item:hover {
  border-color: #58a6ff;
  background: #21262d;
}
.reaction-item.active {
  background: rgba(56, 139, 253, 0.15);
  border-color: #58a6ff;
  color: #58a6ff;
}
.reaction-add-btn {
  background: none;
  border: 1px dashed #30363d;
  border-radius: 20px;
  padding: 2px 8px;
  font-size: 0.75rem;
  color: #8b949e;
  cursor: pointer;
}
.reaction-add-btn:hover {
  border-color: #8b949e;
  color: #fff;
}

/* Markdown Support */
.markdown-body {
  color: #c9d1d9;
  font-size: 0.9rem;
  line-height: 1.5;
  word-wrap: break-word;
}
.markdown-body :deep(pre) {
  background-color: #0d1117;
  padding: 12px;
  border-radius: 6px;
  overflow: auto;
  margin: 8px 0;
}
.markdown-body :deep(code) {
  background-color: rgba(110, 118, 129, 0.4);
  padding: 0.2em 0.4em;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
  font-size: 85%;
}
.markdown-body :deep(p) {
  margin: 0 0 8px 0;
}
.markdown-body :deep(ul), .markdown-body :deep(ol) {
  padding-left: 20px;
  margin: 8px 0;
}
</style>
