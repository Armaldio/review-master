<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useStorage } from "@vueuse/core";
import type { DiffLineAnnotation, AnnotationSide, SelectedLineRange } from "@pierre/diffs";
import { useRouter } from "vue-router";
import { useReviewStore, getLanguage } from "../store";
import PierreDiff from "../components/PierreDiff.vue";
import FileTreeItem from "../components/FileTreeItem.vue";
import type { FileNode } from "../components/FileTreeItem.vue";
import { parseDiffFromFile } from "@pierre/diffs";
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
const currentTab = ref<"diff" | "semantic" | "ast">("diff");
const isSubmitting = ref(false);
const isMarkingAsReady = ref(false);
const isRefreshing = ref(false);

const sidebarWidth = useStorage("review_sidebar_width", 320);
const isResizing = ref(false);

// Track manual expansion/collapse of threads
const expandedThreads = ref<Set<string>>(new Set());
const isResolving = ref<Record<string, boolean>>({});

const startResize = (e: MouseEvent) => {
  isResizing.value = true;
  document.body.classList.add("is-resizing");
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", stopResize);
};

const onMouseMove = (e: MouseEvent) => {
  if (!isResizing.value) return;
  const newWidth = Math.max(200, Math.min(e.clientX, window.innerWidth * 0.7));
  sidebarWidth.value = newWidth;
};

const stopResize = () => {
  isResizing.value = false;
  document.body.classList.remove("is-resizing");
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", stopResize);
};

// --- Scroll to top on file switch ---
watch(() => store.selectedFile, () => {
    nextTick(() => {
        const diffArea = document.querySelector(".diff-area");
        if (diffArea) diffArea.scrollTop = 0;
    });
});

// Review Submission State
const showReviewModal = ref(false);
const reviewComment = ref('');
const reviewAction = ref<'approve' | 'request_changes' | 'comment'>('comment');

// File Comment State
const fileCommentBody = ref('');

const exitReview = () => {
  router.push("/");
};

// Inline comment state
const inlineCommentLocation = ref<{
  lineNumber: number;
  side: AnnotationSide;
  range?: SelectedLineRange;
} | null>(null);
const editingCommentId = ref<string | null>(null);
const editingBody = ref<string>('');

// Track annotation version to force re-renders
const annotationVersion = ref(0);

if (!store.mrData) {
  router.push("/");
}

const isAuthor = computed(() => {
  if (!store.mrData || !store.currentUser) return false;
  return store.mrData.author_username === store.currentUser.username;
});

const modifiedFiles = computed(() => store.diffs.map((d) => d.new_path));

const relevantFiles = computed(() => {
  let files = modifiedFiles.value;

  if (
    showOnlyMyFiles.value &&
    store.currentUser &&
    store.codeownersRules.length > 0
  ) {
    const myUsername = `@${store.currentUser.username}`;
    const myGroups: string[] = store.currentUser.groups || [];
    files = files.filter((filePath) => {
      const owners = store.fileOwners[filePath] || [];
      const hasDirectMatch = owners.includes(myUsername);
      const hasGroupMatch = myGroups.some((g: string) => owners.includes(g));
      return hasDirectMatch || hasGroupMatch;
    });
  }

  return files;
});

const totalFilesCount = computed(() => relevantFiles.value.length);
const viewedCount = computed(() => relevantFiles.value.filter(f => !!store.viewedFiles[f]).length);

const progressPercent = computed(() => {
  if (totalFilesCount.value === 0) return 0;
  return Math.round((viewedCount.value / totalFilesCount.value) * 100);
});

const displayedFiles = computed(() => {
  const files = [...relevantFiles.value];

  // Sort: Unviewed first, then viewed
  return files.sort((a, b) => {
    const aViewed = !!store.viewedFiles[a];
    const bViewed = !!store.viewedFiles[b];
    if (aViewed === bViewed) return a.localeCompare(b);
    return aViewed ? 1 : -1;
  });
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

const orphanedComments = computed(() => {
    const filePaths = new Set(store.diffs.map(d => d.new_path));
    return store.batchedComments.filter(c => !filePaths.has(c.new_path));
});

const file = computed(() => {
  if (!store.selectedFile) return null;
  return store.diffs.find((d) => d.new_path === store.selectedFile) || null;
});

const parsedFileDiff = computed(() => {
  const f = file.value;
  if (!f) return null;

  // We only render once we have the full file content (Simplified + Stable)
  const contents = store.fileContents[f.new_path];
  if (contents) {
    try {
      const language = getLanguage(f.new_path).toLowerCase();
      // Local calculation ONLY (requested by user)
      const metadata = parseDiffFromFile(
        { name: f.old_path || "/dev/null", contents: contents.old, lang: language },
        { name: f.new_path || "/dev/null", contents: contents.new, lang: language },
        { context: 3 }
      );

      return (metadata as any);
    } catch (e) {
      console.warn("Failed to generate metadata from contents/patch", e);
    }
  }

  return null;
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

const PENCIL_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-edit-2">
  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
</svg>
`;

const selectFile = async (path: string) => {
  store.selectFile(path);
  inlineCommentLocation.value = null;
};

watch(
  () => store.selectedFile,
  (newFile) => {
    if (newFile) {
      // Find the file metadata if not already available
      const f = store.diffs.find((d) => d.new_path === newFile);
      if (f) {
        store.fetchFileContents(f);
        
        if (currentTab.value === "semantic") {
          store.fetchSemanticDiff(f);
        }
        if (currentTab.value === "ast") {
          store.fetchAstDiff(f);
        }
      }
    }
  },
  { immediate: true }
);

// Auto-select first file if none selected
watch(
  () => modifiedFiles.value,
  (files) => {
    if (!store.selectedFile && files && files.length > 0) {
      store.selectFile(files[0]);
    }
  },
  { immediate: true }
);

watch(currentTab, (newTab) => {
  if (newTab === "semantic" && file.value) {
    store.fetchSemanticDiff(file.value);
  }
  if (newTab === "ast" && file.value) {
    store.fetchAstDiff(file.value);
  }
});

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
        await store.activeProvider.addReaction(comment, platformEmoji);

        // Optimistically update UI
        if (!comment.reactions) comment.reactions = [];
        const existing = comment.reactions.find((r: any) => r.name === emojiChar);
        if (existing) {
            existing.count++;
            if (store.currentUser?.name) {
                if (!existing.users) existing.users = [];
                existing.users.push(store.currentUser.name);
            }
        } else {
            comment.reactions.push({
                name: emojiChar,
                count: 1,
                users: store.currentUser?.name ? [store.currentUser.name] : []
            });
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
      (f) => !store.viewedFiles[f],
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
  if (confirm('Are you sure you want to delete this comment?')) {
      try {
          await store.activeProvider.deleteComment(comment.id);
          store.removeRemoteComment(comment.id);
          annotationVersion.value++;
      } catch (err) {
          alert(`Delete failed: ${(err as Error).message}`);
      }
  }
};

const startEdit = (comment: any) => {
    editingCommentId.value = comment.id;
    editingBody.value = comment.body;
    annotationVersion.value++;
};

const cancelEdit = () => {
    editingCommentId.value = null;
    editingBody.value = '';
    annotationVersion.value++;
};

const saveEdit = async (comment: any) => {
    if (!store.activeProvider) return;
    const newBody = editingBody.value.trim();
    if (!newBody || newBody === comment.body) {
        cancelEdit();
        return;
    }

    try {
        await store.activeProvider.editComment(comment.id, newBody);

        // Optimistically update
        const c = store.remoteComments.find(rc => rc.id === comment.id);
        if (c) c.body = newBody;

        cancelEdit();
    } catch (err) {
        alert(`Edit failed: ${(err as Error).message}`);
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

const submitReview = async () => {
    if (!store.activeProvider) return;
    isSubmitting.value = true;
    try {
        await store.activeProvider.submitReview(reviewComment.value, reviewAction.value);
        alert(`Review submitted as ${reviewAction.value}!`);
        showReviewModal.value = false;
        reviewComment.value = '';
    } catch (err) {
        alert(`Review failed: ${(err as Error).message}`);
    } finally {
        isSubmitting.value = false;
    }
};

const postFileComment = async () => {
    if (!store.activeProvider || !store.selectedFile) return;
    const body = fileCommentBody.value.trim();
    if (!body) return;
    
    isSubmitting.value = true;
    try {
        const comment = await store.activeProvider.postFileComment(store.selectedFile, body);
        store.remoteComments.push(comment);
        fileCommentBody.value = '';
        annotationVersion.value++;
    } catch (err) {
        alert(`File comment failed: ${(err as Error).message}`);
    } finally {
        isSubmitting.value = false;
    }
};

const markAsReady = async () => {
    if (!store.activeProvider) return;
    isMarkingAsReady.value = true;
    try {
        await store.activeProvider.markAsReady();
        // The provider update its own state internally, 
        // mrData.draft is a reactive property so the button will disappear.
    } catch (err) {
        alert(`Failed to mark as ready: ${(err as Error).message}`);
    } finally {
        isMarkingAsReady.value = false;
    }
};

const refreshMR = async () => {
    if (!store.mrUrl) return;
    isRefreshing.value = true;
    try {
        await store.initializeMR(store.mrUrl);
    } catch (err) {
        alert(`Refresh failed: ${(err as Error).message}`);
    } finally {
        isRefreshing.value = false;
    }
};

const toggleResolve = async (discussionId: string, currentStatus: boolean | undefined) => {
    if (!store.activeProvider) return;
    isResolving.value[discussionId] = true;
    try {
        await store.activeProvider.resolveThread(discussionId, !currentStatus);
        // State is updated inside the provider, but we need to trigger a redraw
        annotationVersion.value++;
    } catch (err) {
        alert(`Failed to toggle resolution: ${(err as Error).message}`);
    } finally {
        isResolving.value[discussionId] = false;
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
// Removed getLanguage - now imported from store

const baseDiffOptions = computed(() => ({
  diffStyle: viewMode.value ?? 'split',
  overflow: wordWrap.value ? 'wrap' as const : 'scroll' as const,
  expandUnchanged: false, // DO NOT expand all by default; this ensures the "hunk-only" view
  collapsedContextThreshold: 1, 
}));

const getSemanticDiffOptions = (change: any, overrideLanguage?: string) => ({
  ...baseDiffOptions.value,
  expandUnchanged: false, // Fragments should not move/show markers
  enableGutterUtility: false, // No comments on semantic cards yet
  enableLineSelection: false,
  language: (overrideLanguage || getLanguage(change.filePath)).toLowerCase(),
});

const getFileContentFromChange = (contents: string, filePath: string) => ({
  name: filePath || "/dev/null",
  contents: contents || "",
});

const getAstContent = (items: any[], side: 'lhs' | 'rhs') => {
  return items
    .map(item => {
      const data = item[side];
      if (!data || !data.changes) return null;
      return data.changes.map((c: any) => c.content).join('');
    })
    .filter(c => c !== null)
    .join('\n');
};

const diffOptions = computed(() => ({
  ...baseDiffOptions.value,
  enableGutterUtility: true,
  enableLineSelection: true,
  language: file.value ? getLanguage(file.value.new_path) : 'text',
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
  const firstComment = comments[0];
  const discussionId = firstComment.discussion_id;
  const isResolved = !!firstComment.resolved;
  const isExpanded = discussionId ? expandedThreads.value.has(discussionId) : true;
  const isActuallyCollapsed = isResolved && !isExpanded;

  container.className = `comment-thread-container ${isResolved ? 'resolved' : ''} ${isActuallyCollapsed ? 'collapsed' : ''}`;

  // Add Thread Header
  const threadHeader = document.createElement('div');
  threadHeader.className = 'thread-header';

  const threadInfo = document.createElement('div');
  threadInfo.className = 'thread-info';
  if (isResolved) {
      const badge = document.createElement('span');
      badge.className = 'resolved-badge';
      badge.textContent = '✓ Resolved';
      threadInfo.appendChild(badge);
  }
  const summaryText = document.createElement('span');
  summaryText.className = 'thread-summary';
  summaryText.textContent = isActuallyCollapsed ? `${firstComment.author}: ${firstComment.body.substring(0, 50)}${firstComment.body.length > 50 ? '...' : ''}` : '';
  threadInfo.appendChild(summaryText);
  threadHeader.appendChild(threadInfo);

  const threadActions = document.createElement('div');
  threadActions.className = 'thread-actions';

  // Resolve/Unresolve Button
  if (discussionId) {
      const resolveBtn = document.createElement('button');
      resolveBtn.className = 'thread-btn';
      resolveBtn.textContent = isResolving.value[discussionId] ? '...' : (isResolved ? 'Unresolve' : 'Resolve');
      resolveBtn.disabled = !!isResolving.value[discussionId];
      resolveBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleResolve(discussionId, isResolved);
      });
      threadActions.appendChild(resolveBtn);

      if (isResolved) {
          const toggleBtn = document.createElement('button');
          toggleBtn.className = 'thread-btn';
          toggleBtn.textContent = isExpanded ? 'Hide' : 'Show';
          toggleBtn.addEventListener('click', () => {
              if (isExpanded) expandedThreads.value.delete(discussionId);
              else expandedThreads.value.add(discussionId);
              annotationVersion.value++;
          });
          threadActions.appendChild(toggleBtn);
      }
  }
  threadHeader.appendChild(threadActions);
  container.appendChild(threadHeader);

  if (isActuallyCollapsed) {
      return container;
  }

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
    contentWrapper.className = 'comment-content';
    const header = document.createElement('div');
    header.className = 'comment-header';

    const authorName = document.createElement('span');
    authorName.className = 'comment-author';
    authorName.textContent = comment.author;
    header.appendChild(authorName);

    const time = document.createElement('span');
    time.className = 'comment-time';
    time.textContent = new Date(comment.created_at).toLocaleString();
    header.appendChild(time);
     if (!comment.is_batched) {
        // Only show actions for non-batched comments (though we could support batch edit too)
        const isAuthor = store.currentUser && (comment.author_id === store.currentUser.id || comment.author === store.currentUser.username);

        if (isAuthor) {
            const editBtn = document.createElement('button');
            editBtn.className = 'comment-remove-btn';
            editBtn.innerHTML = PENCIL_ICON;
            editBtn.title = 'Edit comment';
            editBtn.style.marginRight = '4px';
            editBtn.addEventListener('click', () => startEdit(comment));
            header.appendChild(editBtn);
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'comment-remove-btn';
        deleteBtn.innerHTML = TRASH_ICON;
        deleteBtn.title = 'Delete comment';
        deleteBtn.addEventListener('click', () => deleteRemoteComment(comment));
        header.appendChild(deleteBtn);
    }

    contentWrapper.appendChild(header);

    if (editingCommentId.value === comment.id) {
        const editContainer = document.createElement('div');
        editContainer.className = 'reply-input-wrapper';
        editContainer.style.marginTop = '4px';
        editContainer.style.paddingTop = '4px';
        editContainer.style.borderTop = 'none';

        const textarea = document.createElement('textarea');
        textarea.className = 'reply-textarea';
        textarea.value = editingBody.value;
        textarea.addEventListener('input', (e: any) => {
            editingBody.value = e.target.value;
        });
        editContainer.appendChild(textarea);

        const actions = document.createElement('div');
        actions.className = 'reply-actions';
        actions.style.marginTop = '4px';

        const leftActions = document.createElement('div');
        actions.appendChild(leftActions); // Placeholder for emoji if needed

        const rightActions = document.createElement('div');
        rightActions.style.display = 'flex';
        rightActions.style.gap = '8px';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'inline-btn inline-btn-primary';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', () => saveEdit(comment));
        rightActions.appendChild(saveBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'inline-btn inline-btn-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', cancelEdit);
        rightActions.appendChild(cancelBtn);

        actions.appendChild(rightActions);
        editContainer.appendChild(actions);
        contentWrapper.appendChild(editContainer);
    } else {
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
            if (r.users && r.users.length > 0) {
                rel.title = r.users.join(', ');
            }
            rel.addEventListener('click', () => addReaction(comment, r.name));
            reactionRow.appendChild(rel);
        });
        const addReactBtn = document.createElement('button');
        addReactBtn.className = 'reaction-add-btn';
        addReactBtn.textContent = '+';
        addReactBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const picker = createEmojiPicker((emojiChar) => {
                addReaction(comment, emojiChar);
            });
            picker.style.position = 'absolute';
            // Simple positioning logic
            const rect = addReactBtn.getBoundingClientRect();
            picker.style.top = `-100px`;
            picker.style.left = `0`;
            addReactBtn.parentElement?.appendChild(picker);
            const popup = picker.querySelector('.emoji-popup') as HTMLElement;
            if (popup) popup.style.display = 'grid';
        });
        reactionRow.appendChild(addReactBtn);
        contentWrapper.appendChild(reactionRow);
    }

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
      metadata: { type: 'editor', range: inlineCommentLocation.value.range },
    });
  }

  return annotations;
});

</script>

<template>
  <div class="review-container">
    <div class="sidebar" :style="{ width: sidebarWidth + 'px' }">
      <div class="sidebar-header">
        <h3>Files</h3>
        <div class="progress-container">
          <div class="progress-bar-wrapper">
            <div 
              class="progress-bar-fill" 
              :style="{ width: `${progressPercent}%` }"
            ></div>
          </div>
          <div class="progress-text">
            <span>{{ progressPercent }}% validated</span>
            <span>{{ viewedCount }} / {{ totalFilesCount }}</span>
          </div>
        </div>
        <div class="sidebar-filters">
          <!-- Removed showAllFiles toggle as reviewed files are now always visible at the bottom -->
          <div class="filter-group" v-if="store.codeownersRules.length > 0">
            <span class="filter-label">Only my files</span>
            <label class="switch">
              <input type="checkbox" v-model="showOnlyMyFiles" />
              <span class="slider"></span>
            </label>
          </div>
          <div class="filter-group">
            <span class="filter-label">Tree view</span>
            <label class="switch">
              <input type="checkbox" v-model="useTreeView" />
              <span class="slider"></span>
            </label>
          </div>
        </div>
      </div>

      <ul class="file-list" v-if="!useTreeView">
        <li
          v-for="file in displayedFiles"
          :key="file"
          :class="{
            active: store.selectedFile === file,
            viewed: !!store.viewedFiles[file],
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
          :sortViewedToBottom="true"
          @select="selectFile"
        />
      </div>

      <div class="batch-panel" v-if="store.batchedComments.length > 0">
        <h3>Batched Comments ({{ store.batchedComments.length }})</h3>
        <div v-if="orphanedComments.length > 0" class="orphaned-warning">
            ⚠️ {{ orphanedComments.length }} comments on deleted/moved files
        </div>
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

      <div class="global-actions">
        <button class="btn-review" @click="showReviewModal = true">
          Submit Review
        </button>
      </div>
    </div>

    <div class="resizer" @mousedown="startResize"></div>

    <div class="main-content">
      <div class="toolbar">
        <button class="btn-secondary" @click="exitReview">
          Exit Review
        </button>

        <div class="center-controls">
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
          <div class="tab-switcher">
            <button
              :class="{ active: currentTab === 'diff' }"
              @click="currentTab = 'diff'"
            >
              Diff
            </button>
            <button
              :class="{ active: currentTab === 'semantic' }"
              @click="currentTab = 'semantic'"
            >
              Semantic
            </button>
            <button
              :class="{ active: currentTab === 'ast' }"
              @click="currentTab = 'ast'"
            >
              AST
            </button>
          </div>
        </div>

        <div class="primary-actions">
          <button 
            class="btn-secondary" 
            @click="refreshMR" 
            :disabled="isRefreshing"
            title="Refresh MR data"
            style="margin-right: 8px; display: flex; align-items: center; gap: 4px;"
          >
            <span v-if="isRefreshing" class="spinner-small"></span>
            {{ isRefreshing ? 'Refreshing...' : 'Refresh' }}
          </button>
          <button 
            v-if="isAuthor && store.mrData?.draft" 
            class="btn-secondary" 
            @click="markAsReady" 
            :disabled="isMarkingAsReady"
            style="margin-right: 8px;"
          >
            {{ isMarkingAsReady ? 'Marking...' : 'Mark as Ready' }}
          </button>
          <button class="btn-primary" @click="markAsViewed">
            Mark as Viewed
          </button>
        </div>
      </div>

      <div class="diff-area">
        <div class="file-header" v-if="file">
            <div class="file-info">
                <span class="file-name">{{ file.new_path }}</span>
                <span class="file-stats">
                    <span class="added">+{{ parsedFileDiff?.additions || 0 }}</span>
                    <span class="deleted">-{{ parsedFileDiff?.deletions || 0 }}</span>
                </span>
            </div>
            <div class="file-actions">
                <!-- File Comment is now persistent at the bottom -->
            </div>
        </div>

        <template v-if="currentTab === 'diff'">
          <div v-if="file && !parsedFileDiff" class="loading-state">
            <div class="spinner"></div>
            Analyzing diff...
          </div>
          <PierreDiff
            v-else-if="parsedFileDiff && file && store.mrData"
            :key="`${file.new_path}-${viewMode}`"
            :fileDiff="parsedFileDiff"
            :options="diffOptions"
            :lineAnnotations="lineAnnotations"
            :expandedHunks="store.fileExpansionStates[file.new_path]"
            @expand-hunk="(map) => store.updateExpansionState(file!.new_path, map)"
            :oldFile="store.fileContents[file.new_path]?.old ? getFileContentFromChange(store.fileContents[file.new_path]?.old, file.old_path || '/dev/null') : undefined"
            :newFile="store.fileContents[file.new_path]?.new ? getFileContentFromChange(store.fileContents[file.new_path]?.new, file.new_path || '/dev/null') : undefined"
          />
          <div v-else-if="file && !file.diff" class="empty-state">No differences (e.g. binary file or only empty lines)</div>
          <div v-else class="empty-state">Select a file to review</div>
        </template>
        <template v-else-if="currentTab === 'semantic'">
          <div v-if="store.isSemanticLoading" class="loading-state">
            <div class="spinner"></div>
            Analyzing semantic changes...
          </div>
          <div v-else-if="file && store.semanticDiffs[file.new_path]" class="semantic-results">
            <div class="semantic-summary" v-if="store.semanticDiffs[file.new_path].summary">
              <span>{{ store.semanticDiffs[file.new_path].summary.total }} changes:</span>
              <span class="status-count added">{{ store.semanticDiffs[file.new_path].summary.added }} added</span>,
              <span class="status-count modified">{{ store.semanticDiffs[file.new_path].summary.modified }} modified</span>,
              <span class="status-count deleted">{{ store.semanticDiffs[file.new_path].summary.deleted }} deleted</span>
            </div>
            <div v-for="change in store.semanticDiffs[file.new_path].changes" :key="change.entityId" class="semantic-entity">
              <div class="entity-header">
                <span class="entity-status" :class="change.changeType">{{ change.changeType }}</span>
                <span class="entity-type">{{ change.entityType }}</span>
                <span class="entity-name">{{ change.entityName }}</span>
              </div>
              <div class="entity-diff-viewer">
                <PierreDiff
                  :options="getSemanticDiffOptions(change)"
                  :oldFile="getFileContentFromChange(change.beforeContent, change.filePath)"
                  :newFile="getFileContentFromChange(change.afterContent, change.filePath)"
                  :fileDiff="change.diffMetadata"
                />
              </div>
            </div>
            <div v-if="!store.semanticDiffs[file.new_path].changes || store.semanticDiffs[file.new_path].changes.length === 0" class="empty-state">
              No semantic changes detected for this file.
            </div>
          </div>
          <div v-else-if="file" class="empty-state">Click "Semantic" to analyze this file</div>
          <div v-else class="empty-state">Select a file to review</div>
        </template>
        <template v-else-if="currentTab === 'ast'">
          <div v-if="store.isAstLoading" class="loading-state">
            <div class="spinner"></div>
            Analyzing structural AST changes...
          </div>
          <div v-else-if="file && store.astDiffs[file.new_path]" class="ast-results">
            <div class="ast-summary">
               Structural analysis complete. Found {{ store.astDiffs[file.new_path].chunks?.length || 0 }} structural regions.
            </div>
            <div v-for="(chunk, idx) in store.astDiffs[file.new_path].chunks" :key="idx" class="ast-hunk">
               <div class="hunk-header">Region {{ Number(idx) + 1 }}</div>
               <div class="hunk-diff-viewer">
                  <PierreDiff
                    :options="getSemanticDiffOptions({ filePath: file.new_path }, store.astDiffs[file.new_path].language)"
                    :oldFile="getFileContentFromChange(chunk.reconstructedLhs, file.old_path)"
                    :newFile="getFileContentFromChange(chunk.reconstructedRhs, file.new_path)"
                    :fileDiff="chunk.diffMetadata"
                  />
               </div>
            </div>
            <div v-if="!store.astDiffs[file.new_path].chunks || store.astDiffs[file.new_path].chunks.length === 0" class="empty-state">
              No structural differences detected.
            </div>
          </div>
          <div v-else-if="file" class="empty-state">Click "AST" to see structural changes</div>
          <div v-else class="empty-state">Select a file to review</div>
        </template>

        <div class="file-comment-editor" v-if="file">
            <h4>File Comment (Global for this file)</h4>
            <textarea v-model="fileCommentBody" placeholder="Add a comment for this entire file..."></textarea>
            <div class="editor-actions">
                <button class="btn-primary" @click="postFileComment" :disabled="!fileCommentBody.trim() || isSubmitting">Post Comment</button>
            </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Review Modal -->
  <div class="modal-overlay" v-if="showReviewModal" @click.self="showReviewModal = false">
    <div class="modal-content review-modal">
        <h3>Submit Review</h3>
        <div class="form-group">
            <label>Global Comment (optional)</label>
            <textarea v-model="reviewComment" placeholder="Leave a summary comment..."></textarea>
        </div>
        <div class="form-group">
            <label>Action</label>
            <div class="review-actions-grid">
                <label class="action-option" :class="{ active: reviewAction === 'comment' }">
                    <input type="radio" value="comment" v-model="reviewAction" />
                    <div class="action-info">
                        <strong>Comment</strong>
                        <span>Submit general feedback without approving.</span>
                    </div>
                </label>
                <label class="action-option approve" :class="{ active: reviewAction === 'approve' }">
                    <input type="radio" value="approve" v-model="reviewAction" />
                    <div class="action-info">
                        <strong>Approve</strong>
                        <span>Submit feedback and approve these changes.</span>
                    </div>
                </label>
                <label class="action-option request-changes" :class="{ active: reviewAction === 'request_changes' }">
                    <input type="radio" value="request_changes" v-model="reviewAction" />
                    <div class="action-info">
                        <strong>{{ store.platform === 'gitlab' ? 'Request Changes' : 'Request Changes' }}</strong>
                        <span>Submit feedback that must be addressed.</span>
                    </div>
                </label>
            </div>
        </div>
        <div class="modal-footer">
            <button class="btn-secondary" @click="showReviewModal = false">Cancel</button>
            <button class="btn-primary" @click="submitReview" :disabled="isSubmitting">
                {{ isSubmitting ? 'Submitting...' : 'Submit Review' }}
            </button>
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
  background: #252526;
  border-right: 1px solid #333;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
  position: relative;
}
.resizer {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.2s;
  z-index: 10;
  flex-shrink: 0;
}
.resizer:hover, .is-resizing .resizer {
  background: #007acc;
}
.sidebar-header {
  padding: 1rem;
  border-bottom: 1px solid #333;
}
.file-list, .file-tree {
  flex: 1;
  overflow-y: auto;
}
.sidebar-header h3 {
  margin: 0 0 1rem 0;
}
.progress-container {
  margin-bottom: 1rem;
}
.progress-bar-wrapper {
  height: 6px;
  background: #333;
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 6px;
  position: relative;
}
.progress-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #2ea043 0%, #3fb950 100%);
  transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 0 10px rgba(63, 185, 80, 0.4);
}
.progress-text {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #8b949e;
  font-weight: 500;
  letter-spacing: 0.02em;
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
.sidebar-filters {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 0;
}
.filter-group {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.filter-label {
  font-size: 0.8rem;
  color: #8b949e;
}

/* Toggle Switch Styling */
.switch {
  position: relative;
  display: inline-block;
  width: 32px;
  height: 18px;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #30363d;
  transition: .4s;
  border-radius: 34px;
}
.slider:before {
  position: absolute;
  content: "";
  height: 14px;
  width: 14px;
  left: 2px;
  bottom: 2px;
  background-color: #8b949e;
  transition: .4s;
  border-radius: 50%;
}
input:checked + .slider {
  background-color: #238636;
}
input:checked + .slider:before {
  transform: translateX(14px);
  background-color: #fff;
}
input:focus + .slider {
  box-shadow: 0 0 1px #238636;
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
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  flex-shrink: 0;
  gap: 20px;
}
.center-controls {
  display: flex;
  align-items: center;
  gap: 24px;
}
.actions {
  display: contents;
}
.primary-actions {
  justify-self: end;
  display: flex;
  align-items: center;
  gap: 12px;
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
.loading-state {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 100%;
  gap: 1rem;
  color: #8b949e;
}
.spinner {
  width: 30px;
  height: 30px;
  border: 3px solid rgba(255,255,255,.1);
  border-top-color: #007bff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

.tab-switcher {
  display: flex;
  background: #161b22;
  border-radius: 6px;
  padding: 2px;
}
.tab-switcher button {
  background: transparent;
  border: none;
  color: #8b949e;
  padding: 4px 12px;
  font-size: 0.85rem;
  border-radius: 4px;
  cursor: pointer;
}
.tab-switcher button.active {
  background: #30363d;
  color: #fff;
}

.semantic-results {
  padding: 1rem;
  overflow-y: auto;
}
.semantic-summary {
  margin-bottom: 1rem;
  padding: 8px 12px;
  background: #21262d;
  border-radius: 6px;
  font-size: 0.85rem;
  display: flex;
  gap: 8px;
  align-items: center;
}
.status-count.added { color: #2ea043; }
.status-count.modified { color: #d29922; }
.status-count.deleted { color: #f85149; }

.semantic-entity {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  margin-bottom: 0.5rem;
  overflow: hidden;
}
.entity-header {
  padding: 8px 12px;
  background: #21262d;
  display: flex;
  align-items: center;
  gap: 12px;
}
.entity-status {
  font-size: 0.7rem;
  text-transform: uppercase;
  font-weight: bold;
  padding: 2px 6px;
  border-radius: 4px;
}
.entity-status.modified { background: #b67501; color: #fff; }
.entity-status.added { background: #238636; color: #fff; }
.entity-status.deleted { background: #da3633; color: #fff; }

.entity-diff-viewer {
  border-top: 1px solid #30363d;
  background: #0d1117;
  max-height: 400px;
  overflow-y: auto;
}

.entity-diff-viewer :deep(.diff-viewer-wrapper) {
  padding: 0 !important;
  border: none !important;
  background: transparent !important;
}

.entity-diff-viewer :deep(diffs-container),
.hunk-diff-viewer :deep(diffs-container) {
  font-size: 12px !important;
}

.ast-results {
  padding: 1rem;
  overflow-y: auto;
}
.ast-hunk {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  margin-bottom: 1rem;
  overflow: hidden;
}
.hunk-header {
  padding: 8px 12px;
  background: #21262d;
  font-size: 0.85rem;
  font-weight: bold;
  color: #c9d1d9;
}
.hunk-diff-viewer :deep(.diff-viewer-wrapper) {
  padding: 0 !important;
  border: none !important;
  background: transparent !important;
}

.ast-summary {
  margin-bottom: 1rem;
  padding: 8px 12px;
  background: #21262d;
  border-radius: 6px;
  font-size: 0.85rem;
  color: #8b949e;
}

.entity-type {
  color: #8b949e;
  font-style: italic;
  font-size: 0.85rem;
}
.entity-name {
  font-weight: bold;
  color: #c9d1d9;
}
.entity-diff {
  margin: 0;
  padding: 12px;
  font-size: 0.8rem;
  background: #0d1117;
  color: #e6edf3;
  white-space: pre-wrap;
  word-break: break-all;
}

/* Modal Styling */
.modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}
.modal-content {
    background: #252526;
    border: 1px solid #444;
    border-radius: 8px;
    width: 600px;
    max-width: 90vw;
    padding: 24px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
.modal-content h3 {
    margin: 0 0 20px 0;
    color: #fff;
}
.form-group {
    margin-bottom: 20px;
}
.form-group label {
    display: block;
    margin-bottom: 8px;
    color: #8b949e;
    font-size: 0.9rem;
}
.form-group textarea {
    width: 100%;
    height: 120px;
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 12px;
    color: #ccc;
    font-family: inherit;
    resize: vertical;
}
.review-actions-grid {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.action-option {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px;
    border: 1px solid #333;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
}
.action-option:hover {
    background: #2d2d2d;
}
.action-option.active {
    border-color: #007bff;
    background: rgba(0, 123, 255, 0.1);
}
.action-option.approve.active {
    border-color: #2ea043;
    background: rgba(46, 160, 67, 0.1);
}
.action-option.request-changes.active {
    border-color: #f85149;
    background: rgba(248, 81, 73, 0.1);
}
.action-option input {
    margin-top: 4px;
}
.action-info strong {
    display: block;
    color: #fff;
    margin-bottom: 2px;
}
.action-info span {
    font-size: 0.8rem;
    color: #8b949e;
}
.modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    margin-top: 24px;
}

.btn-review {
    background: #007bff;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    cursor: pointer;
}
.btn-review:hover {
    background: #0069d9;
}

/* File Header & Actions */
.file-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    background: #252526;
    border-bottom: 1px solid #333;
    position: sticky;
    top: 0;
    z-index: 10;
}
.file-name {
    font-weight: 600;
    color: #c9d1d9;
}
.file-stats {
    margin-left: 12px;
    font-size: 0.8rem;
    font-family: monospace;
}
.file-stats .added { color: #2ea043; }
.file-stats .deleted { color: #f85149; margin-left: 4px; }

.file-actions {
    display: flex;
    gap: 8px;
}
.btn-icon {
    display: flex;
    align-items: center;
    gap: 6px;
    background: #333;
    color: #ccc;
    border: 1px solid #444;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 0.8rem;
    cursor: pointer;
}
.btn-icon:hover {
    background: #444;
}

.file-comment-editor {
    padding: 24px;
    background: #1c2128;
    border-top: 1px solid #333;
    margin-top: 24px;
}
.file-comment-editor h4 {
    margin: 0 0 12px 0;
    font-size: 0.9rem;
    color: #8b949e;
}
.file-comment-editor textarea {
    width: 100%;
    height: 100px;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 12px;
    color: #ccc;
    margin-bottom: 12px;
    resize: vertical;
    font-family: inherit;
}
.editor-actions {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
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
.primary-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
  margin-right: 24px;
}
.global-actions {
  display: flex;
  gap: 8px;
  padding: 16px;
  border-top: 1px solid #333;
  justify-content: flex-end;
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
  gap: 4px;
  padding: 4px 12px;
  background: #1e1e1e;
  border-left: 3px solid #007acc;
  margin: 8px 0;
  border-radius: 4px;
}
.comment-thread-container.resolved {
  border-left-color: #4caf50;
  opacity: 0.8;
}
.comment-thread-container.collapsed {
  opacity: 0.6;
}
.thread-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.03);
  font-size: 0.75rem;
  border-radius: 4px 4px 0 0 ;
}
.comment-thread-container.collapsed .thread-header {
  border-radius: 4px;
}
.thread-info {
  display: flex;
  align-items: center;
  gap: 8px;
}
.resolved-badge {
  color: #4caf50;
  font-weight: bold;
}
.thread-summary {
  color: #888;
  font-style: italic;
}
.thread-btn {
  background: transparent;
  border: none;
  color: #007acc;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.thread-btn:hover {
  background: rgba(0, 122, 204, 0.1);
}
.thread-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.comment-item {
  display: flex;
  padding: 8px;
  gap: 12px;
}
.comment-item:not(:last-child) {
  border-bottom: 1px solid #30363d;
}
.comment-reply {
  margin-left: 24px;
  border-left: 2px solid #30363d;
  padding-left: 12px;
}
.comment-avatar {
  width: 28px;
  height: 28px;
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
  margin-bottom: 2px;
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
  margin-top: 8px;
  padding-top: 8px;
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

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 400px;
  gap: 1rem;
  color: #888;
  font-size: 0.9rem;
}
.spinner {
  width: 32px;
  height: 32px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-left-color: #007acc;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin {
    to { transform: rotate(360deg); }
}

/* Global resizing states */
:global(body.is-resizing) {
  cursor: col-resize !important;
  user-select: none !important;
}
</style>
