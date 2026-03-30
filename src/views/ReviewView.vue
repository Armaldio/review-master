<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { DiffLineAnnotation, AnnotationSide, SelectedLineRange } from "@pierre/diffs";
import { useRouter } from "vue-router";
import { useReviewStore, getLanguage } from "../store";
import PierreDiff from "../components/PierreDiff.vue";
import FileTreeItem from "../components/FileTreeItem.vue";
import type { FileNode } from "../components/FileTreeItem.vue";
import { parsePatchFiles, parseDiffFromFile } from "@pierre/diffs";
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
      const owners = store.fileOwners[filePath];
      if (!owners) return false;
      return owners.includes(myUsername) || 
             (store.currentUser.groups && owners.some(o => store.currentUser.groups!.includes(o)));
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
  const f = file.value;
  if (!f) return null;

  // We only render once we have the full file content (Simplified + Stable)
  const contents = store.fileContents[f.new_path];
  if (contents) {
    try {
      const language = getLanguage(f.new_path).toLowerCase();
      // Use context: 3 for stability (avoids line-count mismatches at EOF)
      const metadata = parseDiffFromFile(
        { name: f.old_path || "/dev/null", contents: contents.old, lang: language },
        { name: f.new_path || "/dev/null", contents: contents.new, lang: language },
        { context: 3 }
      );

      return (metadata as any);
    } catch (e) {
      console.warn("Failed to generate metadata from full contents", e);
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
  name: filePath,
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
    <div class="sidebar">
      <div class="sidebar-header">
        <h3>Files</h3>
        <div class="sidebar-filters">
          <div class="filter-group">
            <span class="filter-label">Show all files</span>
            <label class="switch">
              <input type="checkbox" v-model="showAllFiles" />
              <span class="slider"></span>
            </label>
          </div>
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
        <div class="actions">
          <button class="btn-primary" @click="markAsViewed">
            Mark as Viewed
          </button>
          <button class="btn-secondary" @click="exitReview">
            Exit Review
          </button>
        </div>
      </div>

      <div class="diff-area">
        <template v-if="currentTab === 'diff'">
          <div v-if="file && !parsedFileDiff" class="loading-state">
            <div class="spinner"></div>
            Analyzing diff...
          </div>
          <PierreDiff
            v-else-if="parsedFileDiff"
            :key="`${file?.new_path}-${viewMode}`"
            :fileDiff="parsedFileDiff"
            :options="diffOptions"
            :lineAnnotations="lineAnnotations"
            :oldFile="store.fileContents[file?.new_path]?.old ? getFileContentFromChange(store.fileContents[file?.new_path]?.old, file?.old_path) : undefined"
            :newFile="store.fileContents[file?.new_path]?.new ? getFileContentFromChange(store.fileContents[file?.new_path]?.new, file?.new_path) : undefined"
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
  gap: 4px;
  padding: 4px 12px;
  margin: 4px 8px;
  background: #1c2128;
  border: 1px solid #30363d;
  border-radius: 6px;
}
.comment-item {
  display: flex;
  gap: 8px;
  padding: 4px 0;
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
</style>
