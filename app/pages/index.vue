<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useReview } from '~/composables/useReview';
import { useZenReview } from '~/composables/useZenReview';
import { codeownersForPath } from '#shared/codeowners';

const app = useReview();
const loadPierreDiff = () => import('~/components/PierreDiff.vue');
const PierreDiff = defineAsyncComponent(loadPierreDiff);
const mode = ref<'split' | 'unified'>('split');
const wrap = ref(false);
const continuous = ref(false);
const continuousRoot = ref<HTMLElement | null>(null);
const continuousVisible = ref(new Set<string>());
let continuousObserver: IntersectionObserver | undefined;
const tree = ref(false);
const showAll = ref(false);
const query = ref('');
const sidebarTab = ref<'files' | 'history'>('files');
const descriptionOpen = ref(false);
const previewOpen = ref(false);
const previewBusy = ref(false);
const previewUrl = ref('');
const previewCandidates = ref<any[]>([]);
const previewKey = ref(0);
const previewWidth = ref(420);
const theme = ref<'light' | 'dark' | 'system'>('system');
const expandedFiles = ref<Record<string, { oldContent: string | null; newContent: string | null }>>({});
const expandingPath = ref('');
const comment = ref('');
const inlinePosition = ref<Record<string, any> | null>(null);
const lineCommentFeedback = ref('');
const commentDraft = ref(true);
const commentBusy = ref(false);
const draftNotesBusy = ref(false);
const replyBusy = ref(false);
const mrActionBusy = ref(false);
const actionMenu = ref<HTMLDetailsElement>();
const editingDraftNote = ref('');
const draftNoteText = ref('');
const summaryOpen = ref(false);
const summary = ref('');
const summaryIntent = ref<'summary' | 'changes'>('summary');
const replyTo = ref('');
const replyText = ref('');
const editingNote = ref('');
const editText = ref('');
const reactions = [
  { name: 'thumbsup', emoji: '👍', label: 'thumbs up' },
  { name: 'thumbsdown', emoji: '👎', label: 'thumbs down' },
  { name: 'laugh', emoji: '😆', label: 'laugh' },
  { name: 'heart', emoji: '❤️', label: 'heart' },
  { name: 'rocket', emoji: '🚀', label: 'rocket' },
  { name: 'eyes', emoji: '👀', label: 'eyes' },
  { name: 'tada', emoji: '🎉', label: 'celebrate' },
  { name: 'white_check_mark', emoji: '✅', label: 'check mark' },
];
const notice = ref('');
const currentMr = ref('');
let pollTimer: ReturnType<typeof setInterval> | undefined;
let hydratedDiffKey = '';

const fileName = (file: any) => file?.new_file ? file.new_path : file?.deleted_file ? file.old_path : file?.new_path;
const {
  zenMode, zenPanel, zenHistoryTab, commits, commitsLoading, commitsLoaded, commitsFailed,
  commitInspection, selectedCommitPath, commitDiffLoading,
  clearZenCloseTimer, closeZenActionMenu, closeZenPanel, commitTime, inspectCommit,
  loadCommits, onZenHandlePointerEnter, onZenHandlePointerLeave, onZenKeydown,
  onZenPanelFocusOut, onZenPanelPointerEnter, onZenPanelPointerLeave,
  returnToSelectedRevision, selectZenHistoryTab, toggleZenMode, toggleZenPanel,
} = useZenReview(app, closeActionMenu, fileName);
const ownerRules = computed(() => app.review.value?.codeowners || []);
function matchOwner(filePath: string) {
  if (!app.review.value || app.review.value.ownerWarning) return null;
  const matched = codeownersForPath(ownerRules.value, filePath);
  if (!matched.matched) return ownerRules.value.length ? false : null;
  if (!matched.owners.length) return false;
  const status = app.review.value.ownerStatus || {};
  if (matched.owners.some(owner => status[owner] === true)) return true;
  if (matched.owners.some(owner => status[owner] === null || status[owner] === undefined)) return null;
  return false;
}
const sourceFiles = computed(() => commitInspection.value?.files ?? app.files.value);
const eligibleFiles = computed(() => sourceFiles.value.filter(file => {
  if (query.value && !fileName(file).toLowerCase().includes(query.value.toLowerCase())) return false;
  if (commitInspection.value || showAll.value) return true;
  return matchOwner(fileName(file)) === true;
}));
const activePath = computed(() => commitInspection.value ? selectedCommitPath.value : app.selectedPath.value);
const activeFile = computed(() => eligibleFiles.value.find(file => fileName(file) === activePath.value) ?? eligibleFiles.value[0] ?? null);
const displayedFiles = computed(() => eligibleFiles.value);
const selectedDiff = computed(() => Boolean(activeFile.value?.diff || (!commitInspection.value && expandedFiles.value[fileName(activeFile.value)])));
const lineCountCache = new WeakMap<object, number>();
function changedLineCount(file: any): number {
  const cached = lineCountCache.get(file);
  if (cached !== undefined) return cached;
  const count = (file.diff.match(/^(?:\+(?!\+)|-(?!--))/gm) || []).length;
  lineCountCache.set(file, count);
  return count;
}
const reviewedCount = computed(() => app.files.value.filter(file => app.reviewed.value[fileName(file)] === file.identity && file.identity).length);
const progressSegments = computed(() => app.files.value.map(file => {
  const path = fileName(file);
  const changedLines = changedLineCount(file);
  return { file, path, changedLines, weight: Math.max(1, changedLines), reviewed: isReviewed(file) };
}));
const totalProgressWeight = computed(() => progressSegments.value.reduce((total, segment) => total + segment.weight, 0));
const reviewedProgressWeight = computed(() => progressSegments.value.reduce((total, segment) => total + (segment.reviewed ? segment.weight : 0), 0));
const totalChangedLines = computed(() => progressSegments.value.reduce((total, segment) => total + segment.changedLines, 0));
const reviewedChangedLines = computed(() => progressSegments.value.reduce((total, segment) => total + (segment.reviewed ? segment.changedLines : 0), 0));
const progress = computed(() => totalProgressWeight.value ? Math.round(reviewedProgressWeight.value * 100 / totalProgressWeight.value) : 0);
const discussionList = computed(() => app.review.value?.discussions || []);
const hasActiveFileDiscussion = computed(() => discussionList.value.some(thread => thread.notes?.some((note: any) => note.position?.new_path === activeFile.value?.new_path || note.position?.old_path === activeFile.value?.old_path)));
const draftNoteList = computed(() => app.review.value?.draftNotes || []);
const reviewerState = computed(() => app.review.value?.mr.reviewers?.find((reviewer: any) => String(reviewer.id) === String(app.review.value?.user.id))?.state || 'unreviewed');
const previewOrigin = computed(() => { try { return new URL(previewUrl.value).origin; } catch { return "'none'"; } });
const framePolicy = computed(() => `frame-src 'self' ${previewOrigin.value}; object-src 'none'; base-uri 'self'`);
const hasUnknownOwner = computed(() => !commitInspection.value && !app.ownershipPending.value && sourceFiles.value.some(file => matchOwner(fileName(file)) === null));
const currentIncrementalVersion = computed(() => app.selectedVersionId.value === app.latestVersionId.value && !app.review.value?.versionIsInitial);
const lineCommentStatus = computed(() => {
  if (commitInspection.value) return 'Commit inspection has no verified merge request line positions. Comments are posted at MR level.';
  if (lineCommentFeedback.value) return lineCommentFeedback.value;
  if (app.review.value?.versionIsInitial) return '';
  if (currentIncrementalVersion.value) return "Inline comments are available only on changed lines that GitLab also exposes in the current MR diff. Other comments are posted at MR level.";
  return 'Inline comments are unavailable on this historical push. Comments below are posted at MR level.';
});
const membershipCheckedLabel = computed(() => {
  const value = app.membershipCheckedAt.value;
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
});

function renderMarkdown(source: string) {
  if (!import.meta.client || !app.mrUrl.value) return source;
  const markup = marked.parse(source, { async: false, gfm: true, breaks: true });
  const fragment = DOMPurify.sanitize(markup, { RETURN_DOM_FRAGMENT: true }) as DocumentFragment;
  const container = document.createElement('div');
  const host = new URL(app.mrUrl.value).origin;
  for (const image of fragment.querySelectorAll('img')) {
    try {
      const target = new URL(image.getAttribute('src') || '', host);
      if (target.origin !== host || !(target.pathname.startsWith('/uploads/') || target.pathname.startsWith(`/api/v4/projects/${app.review.value?.mr.project_id}/uploads/`))) { image.remove(); continue; }
      image.src = `/api/gitlab-image?mrUrl=${encodeURIComponent(app.mrUrl.value)}&imageUrl=${encodeURIComponent(target.toString())}`;
      image.referrerPolicy = 'no-referrer';
      image.loading = 'lazy';
    } catch { image.remove(); }
  }
  for (const link of fragment.querySelectorAll('a')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  container.append(fragment);
  return container.innerHTML;
}

function setFile(file: any) {
  if (!showAll.value && !eligibleFiles.value.some(candidate => fileName(candidate) === fileName(file))) return;
  if (commitInspection.value) {
    selectedCommitPath.value = fileName(file);
    if (!continuous.value) {
      document.querySelector('.diff-scroll')?.scrollTo({ top: 0 });
      document.querySelector('.diff-shell.code-view')?.scrollTo({ top: 0 });
    }
    return;
  }
  app.selectedPath.value = fileName(file);
  const key = `comment:${fileName(file)}`;
  comment.value = app.drafts.value[key] || '';
  if (!continuous.value) {
    document.querySelector('.diff-scroll')?.scrollTo({ top: 0 });
    document.querySelector('.diff-shell.code-view')?.scrollTo({ top: 0 });
  }
}
function openProgressSegment(file: any) {
  if (commitInspection.value) return;
  if (!showAll.value && matchOwner(fileName(file)) !== true) return;
  if (query.value && !fileName(file).toLowerCase().includes(query.value.toLowerCase())) query.value = '';
  setFile(file);
}
function isReviewed(file: any) { return !commitInspection.value && Boolean(file.identity && app.reviewed.value[fileName(file)] === file.identity); }
function isUnreadVersion(version: { id: number }) { return app.unreadVersions.value.some(item => item.id === version.id); }
function shortSha(version: { head_commit_sha: string }) { return version.head_commit_sha?.slice(0, 8) || 'SHA unavailable'; }
function pushTime(version: { created_at: string }) {
  const timestamp = Date.parse(version.created_at || '');
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
    : 'Push time unavailable';
}
function versionStatus(version: { id: number }) {
  const status = app.versionReviewStatus(version.id);
  return status === 'reviewed' ? 'Reviewed' : status === 'in-progress' ? 'In progress' : status === 'no-changes' ? 'No changes' : 'Not reviewed';
}
async function selectHistoryVersion(versionId: number) {
  if (!await app.selectVersion(versionId)) return;
  returnToSelectedRevision();
  sidebarTab.value = 'files';
  expandedFiles.value = {};
  inlinePosition.value = null;
  lineCommentFeedback.value = '';
  const selectedFile = app.files.value.find(file => fileName(file) === app.selectedPath.value);
  if (selectedFile && query.value && !fileName(selectedFile).toLowerCase().includes(query.value.toLowerCase())) query.value = '';
  await nextTick();
  scheduleReviewSupplementals(false);
}
async function showLatestVersion() {
  if (app.latestVersionId.value != null) await selectHistoryVersion(app.latestVersionId.value);
}
function toggleReviewed() {
  if (commitInspection.value || !activeFile.value?.identity) return;
  const mark = !isReviewed(activeFile.value);
  app.setReviewed(activeFile.value, mark);
  if (mark && app.autoAdvance.value) navigate(1);
}
function navigate(delta: number) {
  const rows = displayedFiles.value;
  if (!rows.length) return;
  const index = rows.findIndex((file: any) => fileName(file) === activePath.value);
  for (let step = 1; step <= rows.length; step++) {
    const target = rows[(index + delta * step + rows.length) % rows.length];
    if (target && delta > 0 && !isReviewed(target)) return setFile(target);
  }
  if (delta > 0) return;
  setFile(rows[(index + delta + rows.length) % rows.length]);
}
function saveDraft() {
  if (!activeFile.value) return;
  if (commitInspection.value) return app.setDraft('mr:comment', comment.value);
  app.setDraft(`comment:${fileName(activeFile.value)}`, comment.value);
}
async function sendComment() {
  if (commentBusy.value || !comment.value.trim() || !activeFile.value) return;
  const inspectingCommit = Boolean(commitInspection.value);
  commentBusy.value = true;
  try {
    await app.call('comment', { body: comment.value, draft: commentDraft.value, ...(!inspectingCommit && inlinePosition.value ? { position: inlinePosition.value } : {}) });
    comment.value = '';
    if (!inspectingCommit) inlinePosition.value = null;
    saveDraft();
    if (!commentDraft.value) await app.refresh();
    notice.value = commentDraft.value ? 'Saved as a GitLab draft note' : 'Comment posted';
  } catch { /* error is shown in the header */ }
  finally { commentBusy.value = false; }
}
function positionBase(useOfficialVersionRefs = false) {
  const refs = useOfficialVersionRefs ? app.review.value?.commentRefs : app.review.value?.mr.diff_refs;
  if (!refs?.base_sha || !refs?.head_sha || !refs?.start_sha || !activeFile.value) return null;
  return { base_sha: refs.base_sha, head_sha: refs.head_sha, start_sha: refs.start_sha, old_path: activeFile.value.old_path, new_path: activeFile.value.new_path, position_type: 'text' };
}
function selectDiffLine(line: { lineNumber: number; side: 'new' | 'old' }) {
  if (commitInspection.value) return;
  const review = app.review.value;
  const incrementalLatest = currentIncrementalVersion.value;
  if (!review?.versionIsInitial && !incrementalLatest) {
    inlinePosition.value = null;
    lineCommentFeedback.value = 'This historical line has no verified position in GitLab’s current MR diff. The comment will be posted at MR level.';
    return;
  }
  if (incrementalLatest) {
    const match = review?.commentableLines?.find(item => item.old_path === activeFile.value?.old_path && item.new_path === activeFile.value?.new_path);
    const coordinates = line.side === 'new' ? match?.new_lines : match?.old_lines;
    if (!coordinates?.includes(line.lineNumber)) {
      inlinePosition.value = null;
      lineCommentFeedback.value = 'GitLab’s current MR diff does not contain this changed line, so it cannot be safely anchored. The comment will be posted at MR level.';
      return;
    }
  }
  const base = positionBase(Boolean(incrementalLatest));
  if (!base) { app.error.value = 'GitLab has not provided current diff references for this file.'; return; }
  lineCommentFeedback.value = '';
  inlinePosition.value = { ...base, [line.side === 'new' ? 'new_line' : 'old_line']: line.lineNumber };
}
function selectDiffRange(range: { start: number; end: number; side?: string; endSide?: string }) {
  if (commitInspection.value) return;
  const review = app.review.value;
  if (currentIncrementalVersion.value) {
    inlinePosition.value = null;
    lineCommentFeedback.value = 'Multiline comments are not enabled for incremental pushes because GitLab line codes cannot be matched safely. The comment will be posted at MR level.';
    return;
  }
  if (!review?.versionIsInitial) {
    inlinePosition.value = null;
    lineCommentFeedback.value = 'Multiline comments are unavailable on this historical push. The comment will be posted at MR level.';
    return;
  }
  const base = positionBase();
  if (!base || !activeFile.value) { app.error.value = 'GitLab has not provided current diff references for this file.'; return; }
  const point = (line: number, side?: string) => {
    const isNew = side !== 'deletions';
    const oldLine = isNew ? null : line;
    const newLine = isNew ? line : null;
    const blob = isNew ? activeFile.value!.new_id : activeFile.value!.old_id;
    return { line_code: `${blob || app.review.value!.mr.sha}_${oldLine ?? 0}_${newLine ?? 0}`, type: isNew ? 'new' : 'old', old_line: oldLine, new_line: newLine };
  };
  lineCommentFeedback.value = '';
  inlinePosition.value = { ...base, line_range: { start: point(range.start, range.side), end: point(range.end, range.endSide) } };
}
async function expandFile(file: any) {
  if (commitInspection.value) return;
  const path = fileName(file);
  if (expandedFiles.value[path]) return;
  expandingPath.value = path;
  try {
    const oldContent = file.new_file ? null : (await app.call<{ content: string }>('files', { path: file.old_path, ref: app.review.value!.mr.diff_refs?.base_sha || app.review.value!.mr.target_branch })).content;
    const newContent = file.deleted_file ? null : (await app.call<{ content: string }>('files', { path: file.new_path, ref: app.review.value!.mr.sha })).content;
    expandedFiles.value = { ...expandedFiles.value, [path]: { oldContent, newContent } };
  } catch { /* error is shown in the header */ }
  finally { expandingPath.value = ''; }
}
async function discoverPreview() {
  previewBusy.value = true;
  try {
    const result = await app.call<{ previews: any[] }>('preview');
    previewCandidates.value = result.previews;
    if (!previewUrl.value) previewUrl.value = result.previews.find(candidate => candidate.url.startsWith('https://'))?.url || '';
  } catch { previewCandidates.value = []; }
  finally { previewBusy.value = false; }
}
async function refreshPreview() {
  await discoverPreview();
  previewKey.value++;
}
async function setPreview(value: string) {
  const isHttp = new URL(value).protocol === 'http:';
  if (isHttp && !window.confirm('This preview uses HTTP and its traffic is not encrypted. Open it anyway?')) return;
  const result = await app.call<{ url: string }>('open-preview', { url: value, confirmedHttp: isHttp });
  previewUrl.value = result.url;
  previewKey.value++;
}
async function mrAction(action: string) {
  if (mrActionBusy.value) return;
  mrActionBusy.value = true;
  try {
    await app.call(action);
    if (['ready', 'approve', 'unapprove'].includes(action)) await refreshReview(true);
    notice.value = action === 'ready' ? 'Merge request marked ready' : action === 'approve' ? 'Merge request approved' : 'Approval removed';
  } catch { /* error is shown in the header */ }
  finally { mrActionBusy.value = false; }
}
async function sendSummary() {
  const isChangeRequest = summaryIntent.value === 'changes';
  try { await app.call(isChangeRequest ? 'request-changes' : 'summary', { body: summary.value }); summaryOpen.value = false; summary.value = ''; app.setDraft('mr:summary', ''); notice.value = isChangeRequest ? 'Changes requested' : 'Summary posted'; await refreshReview(); }
  catch { /* error is shown in the header */ }
}
async function sendReply(discussionId: string) {
  if (replyBusy.value || !replyText.value.trim()) return;
  replyBusy.value = true;
  try { await app.call('reply', { discussionId, body: replyText.value, draft: commentDraft.value }); replyText.value = ''; app.setDraft(`reply:${discussionId}`, ''); replyTo.value = ''; await refreshReview(true); }
  catch { /* error is shown in the header */ }
  finally { replyBusy.value = false; }
}
function startEditDraft(note: any) { editingDraftNote.value = String(note.id); draftNoteText.value = app.drafts.value[`draft-note:${note.id}`] ?? note.note; }
async function saveDraftNote(note: any) {
  if (draftNotesBusy.value || !draftNoteText.value.trim()) return;
  draftNotesBusy.value = true;
  try {
    await app.call('edit-draft-note', { draftNoteId: note.id, note: draftNoteText.value });
    app.setDraft(`draft-note:${note.id}`, '');
    editingDraftNote.value = '';
    await refreshReview(true);
    notice.value = 'Draft note saved';
  } catch { /* error is shown in the header */ }
  finally { draftNotesBusy.value = false; }
}
async function deleteDraftNote(note: any) {
  if (draftNotesBusy.value || !window.confirm('Delete this draft note?')) return;
  draftNotesBusy.value = true;
  try {
    await app.call('delete-draft-note', { draftNoteId: note.id });
    app.setDraft(`draft-note:${note.id}`, '');
    if (editingDraftNote.value === String(note.id)) editingDraftNote.value = '';
    await refreshReview(true);
    notice.value = 'Draft note deleted';
  } catch { /* error is shown in the header */ }
  finally { draftNotesBusy.value = false; }
}
async function publishDraftNotes() {
  if (draftNotesBusy.value || !draftNoteList.value.length) return;
  draftNotesBusy.value = true;
  try {
    await app.call('publish-drafts');
    await refreshReview(true);
    notice.value = 'Draft notes published';
  } catch { /* error is shown in the header */ }
  finally { draftNotesBusy.value = false; }
}
async function saveEditedNote(discussionId: string, noteId: string) {
  try { await app.call('edit-comment', { discussionId, noteId, body: editText.value }); editingNote.value = ''; app.setDraft(`edit:${noteId}`, ''); await app.refresh(); }
  catch { /* error is shown in the header */ }
}
async function deleteNote(discussionId: string, noteId: string) {
  if (!window.confirm('Delete this comment?')) return;
  try { await app.call('delete-comment', { discussionId, noteId }); await app.refresh(); }
  catch { /* error is shown in the header */ }
}
async function toggleReaction(note: any, emoji: string) {
  const current = (note.award_emoji || []).find((award: any) => award.name === emoji && String(award.user?.id) === String(app.review.value?.user.id));
  try { await app.call('reaction', { noteId: note.id, emoji, remove: !!current, awardId: current?.id }); await app.refresh(); }
  catch { /* error is shown in the header */ }
}
async function refreshReview(force = false) {
  const previousDiffIdentity = app.review.value ? `${app.review.value.mr.sha}:${app.review.value.mr.diff_refs?.base_sha || ''}:${app.review.value.mr.diff_refs?.head_sha || ''}:${app.review.value.mr.diff_refs?.start_sha || ''}` : '';
  await app.refresh(force);
  const nextDiffIdentity = app.review.value ? `${app.review.value.mr.sha}:${app.review.value.mr.diff_refs?.base_sha || ''}:${app.review.value.mr.diff_refs?.head_sha || ''}:${app.review.value.mr.diff_refs?.start_sha || ''}` : '';
  if (previousDiffIdentity && nextDiffIdentity !== previousDiffIdentity && previewOpen.value) {
    expandedFiles.value = {};
    previewCandidates.value = [];
    previewUrl.value = '';
    await discoverPreview();
  } else if (previousDiffIdentity && nextDiffIdentity !== previousDiffIdentity) {
    expandedFiles.value = {};
  }
  if (previousDiffIdentity && nextDiffIdentity !== previousDiffIdentity) {
    await nextTick();
    scheduleReviewSupplementals(false);
  }
}
async function refreshZenReview(event: MouseEvent) {
  const trigger = event.currentTarget as HTMLButtonElement;
  await refreshReview(true);
  await nextTick();
  if (zenMode.value && zenPanel.value === 'controls' && trigger.isConnected) trigger.focus();
}
function onVisibility() { if (!document.hidden) void refreshReview(); }
function showSummary(intent: 'summary' | 'changes') { summaryIntent.value = intent; summary.value = app.drafts.value['mr:summary'] || ''; summaryOpen.value = true; }
function showReply(discussionId: string) { replyTo.value = discussionId; replyText.value = app.drafts.value[`reply:${discussionId}`] || ''; }
function startEdit(note: any) { editingNote.value = String(note.id); editText.value = app.drafts.value[`edit:${note.id}`] || note.body; }
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme.value;
  localStorage.setItem('review-master-theme', theme.value);
}

function closeActionMenu() {
  if (actionMenu.value) actionMenu.value.open = false;
}
async function selectZenRevision(versionId: number) {
  if (!await app.selectVersion(versionId)) return;
  returnToSelectedRevision();
  expandedFiles.value = {};
  inlinePosition.value = null;
  lineCommentFeedback.value = '';
  const selectedFile = app.files.value.find(file => fileName(file) === app.selectedPath.value);
  if (selectedFile && query.value && !fileName(selectedFile).toLowerCase().includes(query.value.toLowerCase())) query.value = '';
  await nextTick();
  scheduleReviewSupplementals(false);
}
function startPreviewResize() {
  const onMove = (move: PointerEvent) => { previewWidth.value = Math.max(320, Math.min(window.innerWidth * .7, window.innerWidth - move.clientX)); };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    localStorage.setItem('review-master-preview-width', String(previewWidth.value));
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
}
function resizePreviewBy(delta: number) { previewWidth.value = Math.max(320, Math.min(window.innerWidth * .7, previewWidth.value + delta)); }
function parseInitialUrl() {
  const params = new URLSearchParams(location.search);
  return params.get('mr') || '';
}
function loadReviewSupplementals(refresh = true) {
  const review = app.review.value;
  if (!review) return;
  const key = `${app.mrUrl.value}:${review.mr.sha}:${review.mr.diff_refs?.base_sha || ''}:${review.mr.diff_refs?.head_sha || ''}`;
  if (key === hydratedDiffKey) return;
  hydratedDiffKey = key;
  void app.verifyOwnership();
  void app.hydrateIdentities().catch(() => {});
  if (refresh) void app.refresh(true);
}
function scheduleReviewSupplementals(refresh = true) {
  requestAnimationFrame(() => requestAnimationFrame(() => loadReviewSupplementals(refresh)));
}
async function start(url: string) {
  currentMr.value = url;
  void loadPierreDiff().catch(() => {});
  try {
    await app.bootstrap(url);
    if (previewOpen.value) void discoverPreview();
    await nextTick();
    scheduleReviewSupplementals();
  }
  catch { /* error is shown in the header */ }
}
onMounted(() => {
  const savedTheme = localStorage.getItem('review-master-theme');
  if (savedTheme === 'light' || savedTheme === 'dark') { theme.value = savedTheme; document.documentElement.dataset.theme = savedTheme; }
  const savedWidth = Number(localStorage.getItem('review-master-preview-width'));
  if (Number.isFinite(savedWidth) && savedWidth >= 320) previewWidth.value = savedWidth;
  const url = parseInitialUrl();
  if (url) void start(url);
  pollTimer = setInterval(() => { if (!document.hidden) void refreshReview(); }, 90_000);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('keydown', onZenKeydown);
});
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer); continuousObserver?.disconnect(); clearZenCloseTimer(); document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('keydown', onZenKeydown); });
watch([continuous, displayedFiles], async () => {
  await nextTick();
  continuousObserver?.disconnect();
  if (!continuous.value || !continuousRoot.value) return;
  continuousObserver = new IntersectionObserver(entries => {
    const visible = new Set(continuousVisible.value);
    for (const entry of entries) {
      const path = (entry.target as HTMLElement).dataset.path;
      if (entry.isIntersecting && path) visible.add(path);
    }
    continuousVisible.value = visible;
  }, { root: continuousRoot.value, rootMargin: '500px 0px' });
  continuousRoot.value.querySelectorAll<HTMLElement>('[data-continuous-path]').forEach(element => continuousObserver!.observe(element));
}, { flush: 'post' });
watch(() => app.selectedPath.value, path => {
  if (commitInspection.value) return;
  const file = app.files.value.find(row => fileName(row) === path);
  if (!file) return;
  comment.value = app.drafts.value[`comment:${fileName(file)}`] || '';
  inlinePosition.value = null;
  lineCommentFeedback.value = '';
});
watch(commitInspection, inspection => {
  comment.value = inspection
    ? app.drafts.value['mr:comment'] ?? comment.value
    : app.drafts.value[`comment:${app.selectedPath.value}`] || '';
});
watch(() => {
  const mr = app.review.value?.mr;
  return mr ? `${mr.sha}:${mr.diff_refs?.base_sha || ''}:${mr.diff_refs?.head_sha || ''}:${mr.diff_refs?.start_sha || ''}` : '';
}, (identity, previous) => {
  if (previous && identity !== previous) { inlinePosition.value = null; lineCommentFeedback.value = ''; }
}, { flush: 'post' });
watch(() => app.latestVersionId.value, (versionId, previous) => {
  if (previous && versionId !== previous && !app.review.value?.versionIsInitial && app.selectedVersionId.value !== versionId) {
    inlinePosition.value = null;
    lineCommentFeedback.value = '';
  }
});
watch(previewOpen, open => { if (open && !previewCandidates.value.length) void discoverPreview(); });
watch(comment, saveDraft);
watch(() => app.addedVersionIds.value.join(','), ids => {
  if (!ids) return;
  const count = ids.split(',').length;
  notice.value = `${count === 1 ? 'A new push is' : `${count} new pushes are`} available in History. Your selected push and review progress stayed in place.`;
});
watch(summary, value => { if (summaryOpen.value) app.setDraft('mr:summary', value); });
watch(replyText, value => { if (replyTo.value) app.setDraft(`reply:${replyTo.value}`, value); });
watch(editText, value => { if (editingNote.value) app.setDraft(`edit:${editingNote.value}`, value); });
watch(draftNoteText, value => { if (editingDraftNote.value) app.setDraft(`draft-note:${editingDraftNote.value}`, value); });
watch(displayedFiles, files => {
  if (commitInspection.value) {
    if (files.length && !files.some(file => fileName(file) === selectedCommitPath.value)) selectedCommitPath.value = fileName(files[0]);
    return;
  }
  if (files.length && !files.some(file => fileName(file) === app.selectedPath.value)) setFile(files[0]);
});
</script>

<template>
  <main class="workspace" :class="{ 'zen-mode': zenMode }">
    <Head><Title>MergePeek — GitLab merge request review</Title><Meta v-if="previewOpen && previewUrl" http-equiv="content-security-policy" :content="framePolicy" /></Head>
    <header class="topbar" :inert="zenMode" :aria-hidden="zenMode">
      <a class="brand" href="#" @click.prevent="notice = 'Launch mpeek with a GitLab merge request URL'">Merge<span>Peek</span></a>
      <template v-if="app.review.value">
        <div class="mr-heading"><strong>{{ app.review.value.mr.title }}</strong><span class="review-state">{{ reviewerState.replaceAll('_', ' ') }}</span><button class="quiet" @click="descriptionOpen = !descriptionOpen">{{ descriptionOpen ? 'Hide details' : 'Details' }}</button></div>
        <div class="top-actions">
          <button class="quiet zen-entry" aria-label="Enter Zen Mode" @click="toggleZenMode">Zen Mode</button>
          <span class="progress-label" :title="`${reviewedCount} of ${app.files.value.length} files reviewed; progress is weighted by returned diff lines, with unavailable diffs counted as one segment`">{{ reviewedCount }}/{{ app.files.value.length }} · {{ progress }}%</span>
          <button class="quiet topbar-refresh" :disabled="app.busy.value" @click="refreshReview(true)">↻ Refresh</button>
          <button class="quiet" @click="previewOpen = !previewOpen">{{ previewOpen ? 'Close preview' : 'Preview' }}</button>
          <details ref="actionMenu" class="action-menu">
            <summary class="quiet">More{{ draftNoteList.length ? ` (${draftNoteList.length})` : '' }}</summary>
            <div class="action-menu-popover">
              <button class="quiet" @click="closeActionMenu(); showSummary('summary')">Summary</button>
              <button class="quiet" @click="closeActionMenu(); showSummary('changes')">Request changes</button>
              <button class="quiet" :disabled="mrActionBusy" @click="closeActionMenu(); mrAction('unapprove')">Unapprove</button>
              <button class="quiet" :disabled="draftNotesBusy || !draftNoteList.length" @click="closeActionMenu(); publishDraftNotes()">Publish drafts{{ draftNoteList.length ? ` (${draftNoteList.length})` : '' }}</button>
              <button class="quiet" :disabled="app.ownershipPending.value" @click="closeActionMenu(); app.refreshMemberships()">Refresh memberships</button>
              <span v-if="membershipCheckedLabel" class="membership-meta">Memberships checked {{ membershipCheckedLabel }}</span>
              <button v-if="app.review.value.mr.draft" class="quiet" :disabled="mrActionBusy" @click="closeActionMenu(); mrAction('ready')">Mark ready</button>
            </div>
          </details>
          <button class="approve" :disabled="mrActionBusy" @click="mrAction('approve')">Approve</button>
          <a class="quiet external" :href="app.review.value.mr.web_url" target="_blank" rel="noreferrer">GitLab ↗</a>
          <button class="icon-button" aria-label="Toggle light and dark theme" @click="toggleTheme">{{ theme === 'dark' ? '☼' : '◐' }}</button>
        </div>
        <span class="progress-sr-only" role="progressbar" aria-label="Review progress weighted by diff size" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="progress" :aria-valuetext="`${reviewedCount} of ${app.files.value.length} files reviewed; ${reviewedChangedLines} of ${totalChangedLines} returned changed lines reviewed`" />
        <div class="progress-track" role="group" aria-label="Changed files; select a segment to open its diff">
          <button v-for="segment in progressSegments" :key="segment.path" type="button" class="progress-segment" :class="{ reviewed: segment.reviewed, selected: segment.path === fileName(activeFile), filtered: !showAll && matchOwner(segment.path) !== true }" :style="{ flexGrow: segment.weight }" :disabled="!showAll && matchOwner(segment.path) !== true" :aria-disabled="!showAll && matchOwner(segment.path) !== true" :aria-label="`Open ${segment.path}; ${segment.reviewed ? 'reviewed' : 'not reviewed'}${!showAll && matchOwner(segment.path) !== true ? '; hidden by owner filter' : ''}; ${segment.changedLines} changed lines`" :aria-current="segment.path === fileName(activeFile) ? 'page' : undefined" :title="`${segment.path} · ${segment.changedLines ? `${segment.changedLines} changed lines` : 'diff size unavailable'} · ${segment.reviewed ? 'reviewed' : 'not reviewed'}${!showAll && matchOwner(segment.path) !== true ? ' · hidden by owner filter' : ''}`" @click="openProgressSegment(segment.file)" />
        </div>
      </template>
    </header>
    <section v-if="zenMode" id="zen-controls-panel" class="zen-controls-panel" :class="{ 'zen-panel-open': zenPanel === 'controls' }" aria-label="Review controls" :aria-hidden="zenPanel !== 'controls'" :inert="zenPanel !== 'controls'" @pointerenter="onZenPanelPointerEnter('controls', $event)" @pointerleave="onZenPanelPointerLeave('controls', $event)" @focusout="onZenPanelFocusOut('controls', $event)">
      <header class="zen-controls-heading"><div><strong>{{ commitInspection ? 'Commit inspection' : 'Review controls' }}</strong><span v-if="commitInspection">Push version {{ app.selectedVersionId.value }} remains selected</span><span v-else>{{ app.review.value?.mr.title }}</span></div><button class="icon-button" aria-label="Close Controls panel" @click="closeZenPanel(true)">×</button></header>
      <div class="zen-control-row">
        <button class="quiet" aria-label="Refresh merge request" :disabled="app.busy.value" @click="refreshZenReview($event)">↻ Refresh</button>
        <button class="quiet" :aria-label="previewOpen ? 'Close preview' : 'Open preview'" @click="previewOpen = !previewOpen">{{ previewOpen ? 'Close preview' : 'Preview' }}</button>
        <details class="action-menu zen-more-actions">
          <summary class="quiet">More{{ draftNoteList.length ? ` (${draftNoteList.length})` : '' }}</summary>
          <div class="action-menu-popover">
            <button class="quiet" @click="closeZenActionMenu($event); showSummary('summary')">Summary</button>
            <button class="quiet" @click="closeZenActionMenu($event); showSummary('changes')">Request changes</button>
            <button class="quiet" :disabled="mrActionBusy" @click="closeZenActionMenu($event); mrAction('unapprove')">Unapprove</button>
            <button class="quiet" :disabled="draftNotesBusy || !draftNoteList.length" @click="closeZenActionMenu($event); publishDraftNotes()">Publish drafts{{ draftNoteList.length ? ` (${draftNoteList.length})` : '' }}</button>
            <button class="quiet" :disabled="app.ownershipPending.value" @click="closeZenActionMenu($event); app.refreshMemberships()">Refresh memberships</button>
            <button v-if="app.review.value?.mr.draft" class="quiet" :disabled="mrActionBusy" @click="closeZenActionMenu($event); mrAction('ready')">Mark ready</button>
          </div>
        </details>
        <button class="approve" :disabled="mrActionBusy" @click="mrAction('approve')">Approve</button>
        <a class="quiet external" :href="app.review.value?.mr.web_url" target="_blank" rel="noreferrer">GitLab ↗</a>
        <button class="icon-button" aria-label="Toggle light and dark theme" @click="toggleTheme">{{ theme === 'dark' ? '☼' : '◐' }}</button>
        <button class="quiet" aria-label="Exit Zen Mode" @click="toggleZenMode">Exit Zen Mode</button>
        <button v-if="commitInspection" class="quiet" @click="selectZenHistoryTab('revisions')">Return to selected revision</button>
      </div>
      <div class="zen-control-row zen-review-controls">
        <span v-if="!commitInspection" class="progress-label">{{ reviewedCount }}/{{ app.files.value.length }} · {{ progress }}%</span>
        <button class="review-toggle" :class="{ reviewed: isReviewed(activeFile) }" :disabled="Boolean(commitInspection) || !activeFile?.identity" @click="toggleReviewed">{{ isReviewed(activeFile) ? 'Mark unreviewed' : 'Mark reviewed' }}</button>
        <button class="quiet" aria-label="Previous file" title="Previous file" @click="navigate(-1)">←</button>
        <button class="quiet" aria-label="Next unreviewed file" :disabled="Boolean(commitInspection)" @click="navigate(1)">Next unreviewed →</button>
        <label class="wrap-toggle"><input :checked="app.autoAdvance.value" type="checkbox" aria-label="Auto-advance to next unreviewed file" @change="app.setAutoAdvance(($event.target as HTMLInputElement).checked)"> Auto-advance</label>
        <div class="segmented-control" role="group" aria-label="Diff layout">
          <button :aria-pressed="mode === 'split'" @click="mode = 'split'">Split</button>
          <button :aria-pressed="mode === 'unified'" @click="mode = 'unified'">Unified</button>
        </div>
        <label class="wrap-toggle"><input v-model="wrap" type="checkbox"> Wrap lines</label>
        <label class="wrap-toggle"><input v-model="continuous" type="checkbox"> Continuous files</label>
      </div>
    </section>
    <div v-if="app.busy.value && !app.review.value" class="loading-state" role="status" aria-live="polite" aria-busy="true">
      <span class="loading-spinner" aria-hidden="true" />
      <span>Loading merge request…</span>
    </div>
    <div v-else-if="!app.review.value && !app.error.value" class="empty-state">Launch a review with <code>mpeek &lt;merge-request-url&gt;</code>.</div>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-if="app.review.value?.mr.description && descriptionOpen" class="description" v-html="renderMarkdown(app.review.value.mr.description)" />
    <div v-if="app.error.value" class="error-banner" role="alert"><span>{{ app.error.value }}</span><button v-if="!app.review.value && currentMr" class="quiet" :disabled="app.busy.value" @click="start(currentMr)">Retry</button><button @click="app.error.value = ''">Dismiss</button></div>
    <div v-if="notice" class="notice" role="status" @click="notice = ''">{{ notice }} <button aria-label="Dismiss" @click.stop="notice = ''">×</button></div>
    <div v-if="app.review.value" class="review-layout" :class="{ 'preview-visible': previewOpen, 'zen-mode': zenMode }" :style="{ '--preview-width': `${previewWidth}px` }">
      <aside id="zen-files-panel" class="file-sidebar" :class="{ 'zen-panel-open': zenPanel === 'files' }" :aria-hidden="zenMode && zenPanel !== 'files'" :inert="zenMode && zenPanel !== 'files'" @pointerenter="onZenPanelPointerEnter('files', $event)" @pointerleave="onZenPanelPointerLeave('files', $event)" @focusout="onZenPanelFocusOut('files', $event)">
        <div class="sidebar-tabs" role="tablist" aria-label="Merge request sidebar">
          <button id="files-tab" class="sidebar-tab" role="tab" :aria-selected="sidebarTab === 'files'" aria-controls="files-panel" @click="sidebarTab = 'files'">Files <span class="tab-count">{{ sourceFiles.length }}</span></button>
          <button id="history-tab" class="sidebar-tab" role="tab" :aria-selected="sidebarTab === 'history'" aria-controls="history-panel" :aria-label="`History${app.unreadVersions.value.length ? `, ${app.unreadVersions.value.length} new pushes` : ''}`" @click="sidebarTab = 'history'"><span>History</span><span v-if="app.unreadVersions.value.length" class="history-count">{{ app.unreadVersions.value.length }}</span></button>
        </div>
        <div v-if="sidebarTab === 'files'" id="files-panel" class="sidebar-panel" role="tabpanel" aria-labelledby="files-tab">
          <div class="sidebar-controls"><input v-model="query" placeholder="Find a file" aria-label="Find a file"><button class="icon-button" :aria-label="tree ? 'Use flat list' : 'Use directory tree'" @click="tree = !tree">{{ tree ? '≡' : '⌘' }}</button></div>
          <label class="filter-toggle"><input v-model="showAll" type="checkbox" :disabled="app.ownershipPending.value"> Show all files</label>
          <div v-if="app.review.value.ownerWarning" class="owner-warning">CODEOWNERS could not be verified. Files stay hidden until an owner is confirmed; use Show all files to include them.</div>
          <div v-else-if="hasUnknownOwner" class="owner-warning">Some CODEOWNERS owners could not be verified. Their files stay hidden until membership is confirmed.</div>
          <div v-if="!eligibleFiles.length" class="empty-filter">{{ commitInspection ? 'No files in this commit match the current filters.' : 'No matching files.' }}</div>
          <nav class="file-list" :aria-label="commitInspection ? 'Files changed by inspected commit' : 'Changed files'">
            <button v-for="file in eligibleFiles" :key="file.new_path + file.old_path" class="file-row" :class="{ selected: fileName(file) === activePath }" @click="setFile(file)">
              <span class="file-state" :class="file.new_file ? 'added' : file.deleted_file ? 'deleted' : file.renamed_file ? 'renamed' : ''">{{ file.new_file ? 'A' : file.deleted_file ? 'D' : file.renamed_file ? 'R' : 'M' }}</span>
              <span class="file-path" :title="fileName(file)">{{ tree ? fileName(file).replaceAll('/', ' / ') : fileName(file) }}</span>
              <span v-if="!commitInspection && isReviewed(file)" class="reviewed-mark" aria-label="Reviewed">✓</span>
            </button>
          </nav>
        </div>
        <div v-else id="history-panel" class="history-panel" role="tabpanel" aria-labelledby="history-tab">
          <div class="history-heading"><div><strong>Push history</strong><span>Newest first</span></div><button v-if="app.selectedVersionId.value !== app.latestVersionId.value && app.latestVersionId.value != null" class="quiet" :disabled="app.busy.value" @click="showLatestVersion">Latest push →</button></div>
          <div v-if="!app.versions.value.length" class="history-empty" role="status">GitLab has not returned any push versions.</div>
          <nav v-else class="history-list" aria-label="Push history">
            <button v-for="version in app.versions.value" :key="version.id" class="history-row" :class="{ selected: version.id === app.selectedVersionId.value }" :aria-current="version.id === app.selectedVersionId.value ? 'page' : undefined" :disabled="app.busy.value" @click="selectHistoryVersion(version.id)">
              <span class="history-row-main"><strong class="history-sha">{{ shortSha(version) }}</strong><time :datetime="version.created_at">{{ pushTime(version) }}</time></span>
              <span class="history-row-state"><span v-if="isUnreadVersion(version)" class="history-new">New</span><span class="history-review" :class="`state-${app.versionReviewStatus(version.id)}`">{{ versionStatus(version) }}</span></span>
              <span v-if="version.id === app.selectedVersionId.value" class="history-selected">Selected</span>
            </button>
          </nav>
        </div>
      </aside>
      <section class="review-main">
        <div v-if="app.busy.value && !activeFile" class="empty-state">Loading merge request…</div>
        <div v-else-if="commitInspection && !sourceFiles.length" class="empty-state">GitLab returned no file changes for this commit.</div>
        <template v-else-if="activeFile">
          <div v-if="commitInspection" class="commit-inspection-banner" role="status"><strong>Inspecting {{ commitInspection.commit.short_id || commitInspection.commit.id.slice(0, 8) }}</strong><span>{{ commitInspection.commit.title }} · Push version {{ app.selectedVersionId.value }} remains selected</span><span>Comments are posted at merge request level.</span></div>
          <div class="file-toolbar" :aria-hidden="zenMode" :inert="zenMode">
            <div class="file-heading">
              <div class="path-label"><strong>{{ fileName(activeFile) }}</strong><span v-if="commitInspection" class="commit-inspection-label">Commit inspection · push version {{ app.selectedVersionId.value }} remains selected</span><span v-else-if="activeFile.renamed_file" class="old-path">from {{ activeFile.old_path }}</span></div>
              <button class="review-toggle" :class="{ reviewed: isReviewed(activeFile) }" :disabled="Boolean(commitInspection) || !activeFile.identity" @click="toggleReviewed">{{ isReviewed(activeFile) ? 'Mark unreviewed' : 'Mark reviewed' }}</button>
            </div>
            <div class="file-actions">
              <div class="review-actions">
                <button class="quiet previous-file" aria-label="Previous file" title="Previous file" @click="navigate(-1)">←</button>
                <button class="quiet" aria-label="Next unreviewed file" :disabled="Boolean(commitInspection)" @click="navigate(1)">Next unreviewed →</button>
                <label class="wrap-toggle auto-advance"><input :checked="app.autoAdvance.value" type="checkbox" aria-label="Auto-advance to next unreviewed file" @change="app.setAutoAdvance(($event.target as HTMLInputElement).checked)"> Auto-advance</label>
              </div>
              <div class="view-actions">
                <div class="segmented-control" role="group" aria-label="Diff layout">
                  <button :aria-pressed="mode === 'split'" @click="mode = 'split'">Split</button>
                  <button :aria-pressed="mode === 'unified'" @click="mode = 'unified'">Unified</button>
                </div>
                <details class="display-menu">
                  <summary class="quiet">View</summary>
                  <div class="display-popover">
                    <label class="wrap-toggle"><input v-model="wrap" type="checkbox"> Wrap lines</label>
                    <label class="wrap-toggle"><input v-model="continuous" type="checkbox"> Continuous files</label>
                  </div>
                </details>
              </div>
            </div>
          </div>
          <div v-if="(activeFile.collapsed || activeFile.too_large) && (commitInspection || !expandedFiles[fileName(activeFile)])" class="diff-warning"><strong>{{ commitInspection ? 'GitLab did not return the full commit diff.' : activeFile.too_large ? 'GitLab marked this file as too large.' : 'GitLab collapsed this diff.' }}</strong><span>{{ commitInspection ? 'Full-file expansion and inline comments are unavailable during commit inspection.' : activeFile.too_large ? 'Inline diff is unavailable for this file.' : 'Some context may be missing from the returned patch.' }}</span><button v-if="!commitInspection" class="quiet" :disabled="expandingPath === fileName(activeFile)" @click="expandFile(activeFile)">{{ expandingPath === fileName(activeFile) ? 'Loading…' : 'Load full file' }}</button></div>
          <div class="diff-scroll">
            <div v-if="continuous" ref="continuousRoot" class="continuous-list">
              <article v-for="file in displayedFiles" :key="`${commitInspection?.commit.id || app.selectedVersionId.value}:${file.new_path}`" :data-continuous-path="fileName(file)" :data-path="fileName(file)" class="continuous-file">
                <header><button class="quiet" @click="setFile(file)">{{ fileName(file) }}</button><button class="quiet" @click="setFile(file)">{{ commitInspection ? 'Select file' : 'Comment on file' }}</button></header>
              <component :is="PierreDiff" v-if="continuousVisible.has(fileName(file)) && file.diff" :diff="file.diff" :path="fileName(file)" :old-path="file.old_path" :new-file="file.new_file" :deleted-file="file.deleted_file" :mode="mode" :wrap="wrap" :continuous="true" @ready="loadReviewSupplementals" @line-selected="selectDiffLine" @line-range="selectDiffRange" />
                <pre v-else-if="continuousVisible.has(fileName(file))" class="raw-diff">GitLab did not return an inline diff for this file.</pre>
              </article>
            </div>
            <template v-else>
              <component :is="PierreDiff" v-if="selectedDiff" :key="`${commitInspection?.commit.id || app.selectedVersionId.value}:${fileName(activeFile)}`" :diff="activeFile.diff" :path="fileName(activeFile)" :old-path="activeFile.old_path" :new-file="activeFile.new_file" :deleted-file="activeFile.deleted_file" :mode="mode" :wrap="wrap" :full-files="commitInspection ? undefined : expandedFiles[fileName(activeFile)]" @ready="loadReviewSupplementals" @line-selected="selectDiffLine" @line-range="selectDiffRange" />
              <pre v-else class="raw-diff">{{ activeFile.diff || 'GitLab did not return an inline diff for this file.' }}</pre>
            </template>
          </div>
          <div id="zen-activity-panel" class="comment-panel" :class="{ 'zen-panel-open': zenPanel === 'activity' }" :aria-hidden="zenMode && zenPanel !== 'activity'" :inert="zenMode && zenPanel !== 'activity'" @pointerenter="onZenPanelPointerEnter('activity', $event)" @pointerleave="onZenPanelPointerLeave('activity', $event)" @focusout="onZenPanelFocusOut('activity', $event)">
            <p v-if="lineCommentStatus" class="history-comment-warning" role="status">{{ lineCommentStatus }}</p>
            <section class="draft-notes" :class="{ 'has-draft-notes': draftNoteList.length > 0 }" aria-label="GitLab draft notes">
              <h3>Your GitLab draft notes <span>{{ draftNoteList.length }}</span></h3>
              <p v-if="!draftNoteList.length">No GitLab draft notes.</p>
              <article v-for="note in draftNoteList" :key="note.id" class="note draft-note">
                <template v-if="editingDraftNote === String(note.id)">
                  <textarea v-model="draftNoteText" rows="3" aria-label="Edit GitLab draft note" :disabled="draftNotesBusy"/>
                  <button class="quiet" :disabled="draftNotesBusy || !draftNoteText.trim()" @click="saveDraftNote(note)">{{ draftNotesBusy ? 'Saving…' : 'Save draft note' }}</button>
                  <button class="quiet" :disabled="draftNotesBusy" @click="editingDraftNote = ''; draftNoteText = ''">Cancel</button>
                </template>
                <template v-else>
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <div class="markdown" v-html="renderMarkdown(note.note)"/>
                  <span class="note-line">{{ note.position?.new_line ? `line ${note.position.new_line}` : 'unpublished' }}</span>
                  <button class="quiet" :disabled="draftNotesBusy" :aria-label="`Edit draft note ${note.id}`" @click="startEditDraft(note)">Edit draft</button>
                  <button class="quiet" :disabled="draftNotesBusy" :aria-label="`Delete draft note ${note.id}`" @click="deleteDraftNote(note)">Delete draft</button>
                </template>
              </article>
            </section>
            <details v-if="discussionList.length" class="discussion-group" :open="hasActiveFileDiscussion">
              <summary>Discussions <span>{{ discussionList.length }}</span></summary>
              <details v-for="thread in discussionList" :key="thread.id" class="discussion" :open="thread.notes?.some((note: any) => note.position?.new_path === activeFile?.new_path || note.position?.old_path === activeFile?.old_path)">
                <summary>{{ thread.notes?.[0]?.author?.name || 'Review comment' }} <span>{{ thread.resolved ? 'Resolved' : '' }}</span></summary>
                <!-- eslint-disable-next-line vue/no-v-html -->
                <article v-for="note in thread.notes || []" :key="note.id" class="note"><strong>{{ note.author?.name }}</strong><span class="note-line">{{ note.position?.new_line ? `line ${note.position.new_line}` : 'file discussion' }}</span><template v-if="editingNote === String(note.id)"><textarea v-model="editText" rows="3"/><button class="quiet" @click="saveEditedNote(thread.id, note.id)">Save edit</button><button class="quiet" @click="editingNote = ''">Cancel</button></template><div v-else class="markdown" v-html="renderMarkdown(note.body)"/><div v-if="String(note.author?.id) === String(app.review.value.user.id)" class="note-actions"><button class="quiet" @click="startEdit(note)">Edit</button><button class="quiet" @click="deleteNote(thread.id, note.id)">Delete</button></div><div class="reactions"><button v-for="reaction in reactions" :key="reaction.name" class="reaction" :aria-label="`React with ${reaction.label}`" @click="toggleReaction(note, reaction.name)">{{ (note.award_emoji || []).filter((award: any) => award.name === reaction.name).length ? `${reaction.emoji} ${(note.award_emoji || []).filter((award: any) => award.name === reaction.name).length}` : reaction.emoji }}</button></div></article>
                <form v-if="replyTo === thread.id" class="reply-form" @submit.prevent="sendReply(thread.id)"><textarea v-model="replyText" rows="2" aria-label="Reply to discussion" placeholder="Write a reply…" :disabled="replyBusy"/><button class="approve" :disabled="replyBusy || !replyText.trim()">{{ replyBusy ? 'Sending…' : commentDraft ? 'Save draft reply' : 'Send reply' }}</button></form><button v-else class="quiet" @click="showReply(thread.id)">Reply</button>
                <button class="quiet" @click="app.call('resolve', { discussionId: thread.id, resolved: !thread.resolved }).then(app.refresh)">{{ thread.resolved ? 'Reopen' : 'Resolve' }}</button>
              </details>
            </details>
            <form class="comment-form" @submit.prevent="sendComment"><label for="review-comment">{{ !commitInspection && inlinePosition ? 'Comment on selected diff line' : 'Add an MR-level comment' }}<button v-if="!commitInspection && inlinePosition" type="button" class="quiet" @click="inlinePosition = null">Clear line</button></label><textarea id="review-comment" v-model="comment" rows="3" placeholder="Write a comment…" :disabled="commentBusy"/><div class="comment-actions"><label class="wrap-toggle"><input v-model="commentDraft" type="checkbox"> Save as draft note</label><button class="approve" :disabled="commentBusy || !comment.trim()">{{ commentBusy ? 'Saving…' : commentDraft ? 'Save draft' : 'Post comment' }}</button></div></form>
          </div>
        </template>
        <div v-else class="empty-state">
          <template v-if="app.files.value.length && !showAll">No files are visible in this owner scope. Use Show all files to review every changed file.</template>
          <template v-else-if="app.files.value.length">No files match the current search.</template>
          <template v-else-if="app.review.value.versionIsInitial">No changed files were returned by GitLab.</template>
          <template v-else>No file changes in this push version.</template>
        </div>
      </section>
      <aside v-if="previewOpen" class="preview-pane">
        <button class="preview-resize" aria-label="Resize preview panel" @pointerdown.prevent="startPreviewResize" @keydown.left.prevent="resizePreviewBy(24)" @keydown.right.prevent="resizePreviewBy(-24)" />
        <div class="preview-toolbar"><strong>Review app</strong><select v-if="previewCandidates.length" :value="previewUrl" aria-label="Preview environment" @change="setPreview(($event.target as HTMLSelectElement).value)"><option v-if="!previewUrl" value="" disabled>Select deployment</option><option v-for="candidate in previewCandidates" :key="candidate.url" :value="candidate.url">{{ candidate.environment }} · {{ candidate.match === 'exact' ? 'exact SHA' : 'branch match, may be stale' }}</option></select><button class="quiet" :disabled="previewBusy" @click="refreshPreview">↻</button><a v-if="previewUrl" class="quiet" :href="previewUrl" target="_blank" rel="noreferrer">Open ↗</a><button class="icon-button" aria-label="Close preview" @click="previewOpen = false">×</button></div>
        <div v-if="previewBusy && !previewCandidates.length" class="preview-empty">Finding matching deployments…</div>
        <div v-else-if="!previewUrl" class="preview-empty"><strong>{{ previewCandidates.length ? 'Select a deployment' : 'No matching preview found' }}</strong><span>{{ previewCandidates.length ? 'Choose a verified deployment to open its preview.' : 'A successful deployment for this merge request was not found.' }}</span></div>
        <iframe v-else :key="previewKey" class="preview-frame" :src="previewUrl" :sandbox="'allow-scripts allow-forms allow-same-origin'" referrerpolicy="no-referrer" title="Merge request preview" />
        <p v-if="previewUrl" class="frame-note">This site may block embedding. <a :href="previewUrl" target="_blank" rel="noreferrer">Open it in your browser</a>.</p>
      </aside>
      <aside v-if="zenMode" id="zen-history-panel" class="zen-history-panel" :class="{ 'zen-panel-open': zenPanel === 'history' }" aria-label="Merge request history" :aria-hidden="zenPanel !== 'history'" :inert="zenPanel !== 'history'" @pointerenter="onZenPanelPointerEnter('history', $event)" @pointerleave="onZenPanelPointerLeave('history', $event)" @focusout="onZenPanelFocusOut('history', $event)">
        <header class="zen-history-heading"><div><strong>History</strong><span v-if="commitInspection">Inspecting commit · push {{ app.selectedVersionId.value }} stays selected</span><span v-else>{{ app.selectedVersionId.value === app.latestVersionId.value ? 'Latest push selected' : `Push ${app.selectedVersionId.value} selected` }}</span></div><button class="icon-button" aria-label="Close History panel" @click="closeZenPanel(true)">×</button></header>
        <div class="zen-history-tabs" role="tablist" aria-label="History view">
          <button id="zen-commits-tab" class="zen-history-tab" role="tab" :aria-selected="zenHistoryTab === 'commits'" aria-controls="zen-commits-panel" @click="selectZenHistoryTab('commits')">Commits</button>
          <button id="zen-revisions-tab" class="zen-history-tab" role="tab" :aria-selected="zenHistoryTab === 'revisions'" aria-controls="zen-revisions-panel" @click="selectZenHistoryTab('revisions')">Revisions<span v-if="app.unreadVersions.value.length" class="history-count">{{ app.unreadVersions.value.length }}</span></button>
        </div>
        <section v-if="zenHistoryTab === 'commits'" id="zen-commits-panel" class="zen-history-content" role="tabpanel" aria-labelledby="zen-commits-tab">
          <div class="zen-history-subhead"><span>Commits currently in this merge request</span><button class="quiet" aria-label="Refresh commits" :disabled="commitsLoading" @click="loadCommits(true)">{{ commitsLoading ? 'Loading…' : '↻ Refresh' }}</button></div>
          <p v-if="commitsLoading && !commits.length" class="history-empty" role="status">Loading commits from GitLab…</p>
          <p v-else-if="commitsFailed && !commits.length" class="history-empty" role="alert">GitLab could not load the merge request commits. Refresh to try again.</p>
          <p v-else-if="commitsLoaded && !commits.length" class="history-empty" role="status">GitLab returned no commits for this merge request.</p>
          <nav v-else class="history-list" aria-label="Merge request commits">
            <button v-for="commit in commits" :key="commit.id" class="zen-commit-row" :class="{ selected: commitInspection?.commit.id === commit.id }" :aria-current="commitInspection?.commit.id === commit.id ? 'page' : undefined" :disabled="commitDiffLoading" @click="inspectCommit(commit)">
              <span class="zen-commit-meta"><strong>{{ commit.short_id || commit.id.slice(0, 8) }}</strong><time v-if="commitTime(commit).datetime" :datetime="commitTime(commit).datetime">{{ commitTime(commit).label }}</time><span v-else>{{ commitTime(commit).label }}</span></span>
              <span class="zen-commit-title">{{ commit.title }}</span>
              <span v-if="commit.author_name" class="zen-commit-author">{{ commit.author_name }}</span>
              <span v-if="commitInspection?.commit.id === commit.id" class="history-selected">Inspecting</span>
            </button>
          </nav>
        </section>
        <section v-else id="zen-revisions-panel" class="zen-history-content" role="tabpanel" aria-labelledby="zen-revisions-tab">
          <div class="zen-history-subhead"><span>GitLab push versions · newest first</span><button v-if="app.selectedVersionId.value !== app.latestVersionId.value && app.latestVersionId.value != null" class="quiet" :disabled="app.busy.value" @click="selectZenRevision(app.latestVersionId.value)">Latest push →</button></div>
          <p v-if="!app.versions.value.length" class="history-empty" role="status">GitLab has not returned any push versions.</p>
          <nav v-else class="history-list" aria-label="Push revisions">
            <button v-for="version in app.versions.value" :key="version.id" class="history-row zen-revision-row" :class="{ selected: version.id === app.selectedVersionId.value }" :aria-current="version.id === app.selectedVersionId.value ? 'page' : undefined" :disabled="app.busy.value" @click="selectZenRevision(version.id)">
              <span class="history-row-main"><strong class="history-sha">{{ shortSha(version) }}</strong><time :datetime="version.created_at">{{ pushTime(version) }}</time></span>
              <span class="history-row-state"><span v-if="isUnreadVersion(version)" class="history-new">New</span><span class="history-review" :class="`state-${app.versionReviewStatus(version.id)}`">{{ versionStatus(version) }}</span></span>
              <span v-if="version.id === app.selectedVersionId.value" class="history-selected">Selected</span>
            </button>
          </nav>
        </section>
      </aside>
    </div>
    <div v-if="zenMode" class="zen-edges" aria-label="Zen panels">
      <button id="zen-edge-files" class="zen-edge zen-edge-files" type="button" aria-label="Files panel" aria-controls="zen-files-panel" :aria-expanded="zenPanel === 'files'" title="Files" @pointerenter="onZenHandlePointerEnter('files', $event)" @pointerleave="onZenHandlePointerLeave('files', $event)" @click="toggleZenPanel('files', $event)" />
      <button id="zen-edge-controls" class="zen-edge zen-edge-controls" type="button" aria-label="Controls panel" aria-controls="zen-controls-panel" :aria-expanded="zenPanel === 'controls'" title="Controls" @pointerenter="onZenHandlePointerEnter('controls', $event)" @pointerleave="onZenHandlePointerLeave('controls', $event)" @click="toggleZenPanel('controls', $event)" />
      <button id="zen-edge-history" class="zen-edge zen-edge-history" type="button" aria-label="History panel" aria-controls="zen-history-panel" :aria-expanded="zenPanel === 'history'" title="History" @pointerenter="onZenHandlePointerEnter('history', $event)" @pointerleave="onZenHandlePointerLeave('history', $event)" @click="toggleZenPanel('history', $event)" />
      <button id="zen-edge-activity" class="zen-edge zen-edge-activity" type="button" aria-label="Activity and comments panel" aria-controls="zen-activity-panel" :aria-expanded="zenPanel === 'activity'" title="Activity & Comments" @pointerenter="onZenHandlePointerEnter('activity', $event)" @pointerleave="onZenHandlePointerLeave('activity', $event)" @click="toggleZenPanel('activity', $event)" />
    </div>
    <div v-if="summaryOpen" class="modal-backdrop" @click.self="summaryOpen = false"><form class="modal" @submit.prevent="sendSummary"><h2>{{ summaryIntent === 'changes' ? 'Request changes' : 'Post a review summary' }}</h2><textarea v-model="summary" rows="7" :placeholder="summaryIntent === 'changes' ? 'Explain the changes you are requesting…' : 'Share an overall review note…'"/><div class="modal-actions"><button type="button" class="quiet" @click="summaryOpen = false">Cancel</button><button class="approve">{{ summaryIntent === 'changes' ? 'Post change request' : 'Post summary' }}</button></div></form></div>
  </main>
</template>

<style scoped>
.membership-meta {
  padding: 2px 9px 5px;
  color: var(--muted);
  font-size: 10px;
}

.progress-segment.filtered {
  opacity: .2;
  cursor: not-allowed;
}

.loading-state {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--muted);
}

.loading-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: loading-spin 800ms linear infinite;
}

@keyframes loading-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .loading-spinner {
    animation: none;
    border-top-color: transparent;
    border-left-color: var(--accent);
  }
}
</style>
