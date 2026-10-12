<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useReview } from '~/composables/useReview';

const app = useReview();
const PierreDiff = defineAsyncComponent(() => import('~/components/PierreDiff.vue'));
const mode = ref<'split' | 'unified'>('split');
const wrap = ref(false);
const continuous = ref(false);
const continuousRoot = ref<HTMLElement | null>(null);
const continuousVisible = ref(new Set<string>());
let continuousObserver: IntersectionObserver | undefined;
const tree = ref(false);
const onlyMine = ref(true);
const query = ref('');
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
const commentDraft = ref(true);
const commentBusy = ref(false);
const draftNotesBusy = ref(false);
const replyBusy = ref(false);
const mrActionBusy = ref(false);
const editingDraftNote = ref('');
const draftNoteText = ref('');
const summaryOpen = ref(false);
const summary = ref('');
const summaryIntent = ref<'summary' | 'changes'>('summary');
const replyTo = ref('');
const replyText = ref('');
const editingNote = ref('');
const editText = ref('');
const reactions = ['thumbsup', 'thumbsdown', 'laugh', 'heart', 'rocket', 'eyes', 'tada', 'white_check_mark'];
const notice = ref('');
const currentMr = ref('');
let pollTimer: ReturnType<typeof setInterval> | undefined;

const fileName = (file: any) => file?.new_file ? file.new_path : file?.deleted_file ? file.old_path : file?.new_path;
const ownerRules = computed(() => app.review.value?.codeowners || []);
function matchOwner(filePath: string) {
  if (!app.review.value || app.review.value.ownerWarning) return null;
  const matching = ownerRules.value.filter((rule: any) => globMatches(rule.pattern, filePath));
  if (!matching.length) return ownerRules.value.length ? false : null;
  const bySection = new Map<string, any>();
  for (const rule of matching) bySection.set(rule.section || '', rule);
  const owners = [...bySection.values()].flatMap((rule: any) => rule.owners as string[]);
  const status = app.review.value.ownerStatus || {};
  if (owners.some(owner => status[owner] === null || status[owner] === undefined)) return null;
  return owners.some(owner => status[owner] === true);
}
function globMatches(pattern: string, path: string) {
  if (!pattern || pattern.startsWith('!')) return false;
  const anchored = pattern.startsWith('/');
  const directory = pattern.endsWith('/');
  const normalized = pattern.replace(/^\//, '').replace(/\/$/, '');
  let re = '';
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === '*' && normalized[i + 1] === '*') {
      i++;
      if (normalized[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (normalized[i] === '*') re += '[^/]*';
    else if (normalized[i] === '?') re += '[^/]';
    else re += normalized[i]!.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  if (!anchored && !normalized.includes('/')) re = `(?:^|.*/)${re}`;
  return new RegExp(`^${re}${directory ? '(?:/.*)?' : ''}$`).test(path);
}
const eligibleFiles = computed(() => app.files.value.filter(file => {
  if (query.value && !fileName(file).toLowerCase().includes(query.value.toLowerCase())) return false;
  if (!onlyMine.value) return true;
  return matchOwner(fileName(file)) !== false;
}));
const activeFile = computed(() => app.selected.value);
const displayedFiles = computed(() => eligibleFiles.value);
const selectedDiff = computed(() => Boolean(activeFile.value?.diff || expandedFiles.value[fileName(activeFile.value)]));
const reviewedCount = computed(() => app.files.value.filter(file => app.reviewed.value[fileName(file)] === file.identity && file.identity).length);
const progress = computed(() => app.files.value.length ? Math.round(reviewedCount.value * 100 / app.files.value.length) : 0);
const discussionList = computed(() => app.review.value?.discussions || []);
const draftNoteList = computed(() => app.review.value?.draftNotes || []);
const reviewerState = computed(() => app.review.value?.mr.reviewers?.find((reviewer: any) => String(reviewer.id) === String(app.review.value?.user.id))?.state || 'unreviewed');
const previewOrigin = computed(() => { try { return new URL(previewUrl.value).origin; } catch { return "'none'"; } });
const framePolicy = computed(() => `frame-src 'self' ${previewOrigin.value}; object-src 'none'; base-uri 'self'`);
const hasUnknownOwner = computed(() => !!app.review.value?.ownerWarning || eligibleFiles.value.some(file => matchOwner(fileName(file)) === null));

function renderMarkdown(source: string) {
  if (!import.meta.client || !app.mrUrl.value) return source;
  const markup = marked.parse(source, { async: false, gfm: true, breaks: true });
  const fragment = DOMPurify.sanitize(markup, { RETURN_DOM_FRAGMENT: true }) as DocumentFragment;
  const container = document.createElement('div');
  container.append(fragment);
  const host = new URL(app.mrUrl.value).origin;
  for (const image of container.querySelectorAll('img')) {
    try {
      const target = new URL(image.getAttribute('src') || '', host);
      if (target.origin !== host || !(target.pathname.startsWith('/uploads/') || target.pathname.startsWith(`/api/v4/projects/${app.review.value?.mr.project_id}/uploads/`))) { image.remove(); continue; }
      image.src = `/api/gitlab-image?mrUrl=${encodeURIComponent(app.mrUrl.value)}&imageUrl=${encodeURIComponent(target.toString())}`;
      image.referrerPolicy = 'no-referrer';
      image.loading = 'lazy';
    } catch { image.remove(); }
  }
  for (const link of container.querySelectorAll('a')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  return container.innerHTML;
}

function setFile(file: any) {
  app.selectedPath.value = fileName(file);
  const key = `comment:${fileName(file)}`;
  comment.value = app.drafts.value[key] || '';
  if (!continuous.value) {
    document.querySelector('.diff-scroll')?.scrollTo({ top: 0 });
    document.querySelector('.diff-shell.code-view')?.scrollTo({ top: 0 });
  }
}
function isReviewed(file: any) { return Boolean(file.identity && app.reviewed.value[fileName(file)] === file.identity); }
function toggleReviewed() {
  if (!activeFile.value?.identity) return;
  const mark = !isReviewed(activeFile.value);
  app.setReviewed(activeFile.value, mark);
  if (mark && app.autoAdvance.value) navigate(1);
}
function navigate(delta: number) {
  const rows = displayedFiles.value;
  if (!rows.length) return;
  const index = rows.findIndex((file: any) => fileName(file) === app.selectedPath.value);
  for (let step = 1; step <= rows.length; step++) {
    const target = rows[(index + delta * step + rows.length) % rows.length];
    if (target && delta > 0 && !isReviewed(target)) return setFile(target);
  }
  if (delta > 0) return;
  setFile(rows[(index + delta + rows.length) % rows.length]);
}
function saveDraft() {
  if (!activeFile.value) return;
  app.setDraft(`comment:${fileName(activeFile.value)}`, comment.value);
}
async function sendComment() {
  if (commentBusy.value || !comment.value.trim() || !activeFile.value) return;
  commentBusy.value = true;
  try {
    await app.call('comment', { body: comment.value, draft: commentDraft.value, ...(inlinePosition.value ? { position: inlinePosition.value } : {}) });
    comment.value = '';
    inlinePosition.value = null;
    saveDraft();
    if (!commentDraft.value) await app.refresh();
    notice.value = commentDraft.value ? 'Saved as a GitLab draft note' : 'Comment posted';
  } catch { /* error is shown in the header */ }
  finally { commentBusy.value = false; }
}
function positionBase() {
  const refs = app.review.value?.mr.diff_refs;
  if (!refs?.base_sha || !refs?.head_sha || !refs?.start_sha || !activeFile.value) return null;
  return { base_sha: refs.base_sha, head_sha: refs.head_sha, start_sha: refs.start_sha, old_path: activeFile.value.old_path, new_path: activeFile.value.new_path, position_type: 'text' };
}
function selectDiffLine(line: { lineNumber: number; side: 'new' | 'old' }) {
  const base = positionBase();
  if (!base) { app.error.value = 'GitLab has not provided current diff references for this file.'; return; }
  inlinePosition.value = { ...base, [line.side === 'new' ? 'new_line' : 'old_line']: line.lineNumber };
}
function selectDiffRange(range: { start: number; end: number; side?: string; endSide?: string }) {
  const base = positionBase();
  if (!base || !activeFile.value) { app.error.value = 'GitLab has not provided current diff references for this file.'; return; }
  const point = (line: number, side?: string) => {
    const isNew = side !== 'deletions';
    const oldLine = isNew ? null : line;
    const newLine = isNew ? line : null;
    const blob = isNew ? activeFile.value!.new_id : activeFile.value!.old_id;
    return { line_code: `${blob || app.review.value!.mr.sha}_${oldLine ?? 0}_${newLine ?? 0}`, type: isNew ? 'new' : 'old', old_line: oldLine, new_line: newLine };
  };
  inlinePosition.value = { ...base, line_range: { start: point(range.start, range.side), end: point(range.end, range.endSide) } };
}
async function expandFile(file: any) {
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
async function start(url: string) {
  currentMr.value = url;
  try { await app.bootstrap(url); if (previewOpen.value) void discoverPreview(); }
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
});
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer); continuousObserver?.disconnect(); document.removeEventListener('visibilitychange', onVisibility); });
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
  const file = app.files.value.find(row => fileName(row) === path);
  if (!file) return;
  comment.value = app.drafts.value[`comment:${fileName(file)}`] || '';
  inlinePosition.value = null;
});
watch(previewOpen, open => { if (open && !previewCandidates.value.length) void discoverPreview(); });
watch(comment, saveDraft);
watch(summary, value => { if (summaryOpen.value) app.setDraft('mr:summary', value); });
watch(replyText, value => { if (replyTo.value) app.setDraft(`reply:${replyTo.value}`, value); });
watch(editText, value => { if (editingNote.value) app.setDraft(`edit:${editingNote.value}`, value); });
watch(draftNoteText, value => { if (editingDraftNote.value) app.setDraft(`draft-note:${editingDraftNote.value}`, value); });
watch(displayedFiles, files => { if (files.length && !files.some(file => fileName(file) === app.selectedPath.value)) setFile(files[0]); });
</script>

<template>
  <main class="workspace">
    <Head><Title>MergePeek — GitLab merge request review</Title><Meta v-if="previewOpen && previewUrl" http-equiv="content-security-policy" :content="framePolicy" /></Head>
    <header class="topbar">
      <a class="brand" href="#" @click.prevent="notice = 'Launch mpeek with a GitLab merge request URL'">Merge<span>Peek</span></a>
      <template v-if="app.review.value">
        <div class="mr-heading"><strong>{{ app.review.value.mr.title }}</strong><span class="review-state">{{ reviewerState.replaceAll('_', ' ') }}</span><button class="quiet" @click="descriptionOpen = !descriptionOpen">{{ descriptionOpen ? 'Hide details' : 'Details' }}</button></div>
        <div class="top-actions">
          <span class="progress-label">{{ reviewedCount }}/{{ app.files.value.length }} reviewed</span>
          <button class="quiet" :disabled="app.busy.value" @click="refreshReview(true)">↻ Refresh</button>
          <button class="quiet" @click="previewOpen = !previewOpen">{{ previewOpen ? 'Close preview' : 'Preview' }}</button>
          <button class="quiet" @click="showSummary('summary')">Summary</button>
          <button class="quiet" @click="showSummary('changes')">Request changes</button>
          <button class="quiet" :disabled="mrActionBusy" @click="mrAction('unapprove')">Unapprove</button>
          <button class="quiet" :disabled="draftNotesBusy || !draftNoteList.length" @click="publishDraftNotes">Publish drafts{{ draftNoteList.length ? ` (${draftNoteList.length})` : '' }}</button>
          <button v-if="app.review.value.mr.draft" class="quiet" :disabled="mrActionBusy" @click="mrAction('ready')">Mark ready</button>
          <button class="approve" :disabled="mrActionBusy" @click="mrAction('approve')">Approve</button>
          <a class="quiet external" :href="app.review.value.mr.web_url" target="_blank" rel="noreferrer">GitLab ↗</a>
          <button class="icon-button" aria-label="Toggle light and dark theme" @click="toggleTheme">{{ theme === 'dark' ? '☼' : '◐' }}</button>
        </div>
        <div class="progress-track"><span :style="{ width: `${progress}%` }" /></div>
      </template>
      <form v-else class="url-form" @submit.prevent="start(currentMr)"><input v-model="currentMr" aria-label="Merge request URL" placeholder="Paste a GitLab merge request URL"><button class="approve">Open review</button></form>
    </header>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-if="app.review.value?.mr.description && descriptionOpen" class="description" v-html="renderMarkdown(app.review.value.mr.description)" />
    <div v-if="app.error.value" class="error-banner" role="alert"><span>{{ app.error.value }}</span><button @click="app.error.value = ''">Dismiss</button></div>
    <div v-if="notice" class="notice" role="status" @click="notice = ''">{{ notice }} <button aria-label="Dismiss" @click.stop="notice = ''">×</button></div>
    <div v-if="app.review.value" class="review-layout" :class="{ 'preview-visible': previewOpen }" :style="{ '--preview-width': `${previewWidth}px` }">
      <aside class="file-sidebar">
        <div class="sidebar-title"><span>CHANGES</span><span>{{ app.files.value.length }}</span></div>
        <div class="sidebar-controls"><input v-model="query" placeholder="Find a file" aria-label="Find a file"><button class="icon-button" :aria-label="tree ? 'Use flat list' : 'Use directory tree'" @click="tree = !tree">{{ tree ? '≡' : '⌘' }}</button></div>
        <label class="filter-toggle"><input v-model="onlyMine" type="checkbox"> Only my files</label>
        <div v-if="app.review.value.ownerWarning" class="owner-warning">{{ app.review.value.ownerWarning }}</div>
        <div v-else-if="hasUnknownOwner" class="owner-warning">Some owners could not be verified. Showing all files.</div>
        <div v-if="!eligibleFiles.length" class="empty-filter">No matching files.</div>
        <nav class="file-list" aria-label="Changed files">
          <button v-for="file in eligibleFiles" :key="file.new_path + file.old_path" class="file-row" :class="{ selected: fileName(file) === app.selectedPath.value }" @click="setFile(file)">
            <span class="file-state" :class="file.new_file ? 'added' : file.deleted_file ? 'deleted' : file.renamed_file ? 'renamed' : ''">{{ file.new_file ? 'A' : file.deleted_file ? 'D' : file.renamed_file ? 'R' : 'M' }}</span>
            <span class="file-path" :title="fileName(file)">{{ tree ? fileName(file).replaceAll('/', ' / ') : fileName(file) }}</span>
            <span v-if="app.reviewed.value[fileName(file)] === file.identity && file.identity" class="reviewed-mark" aria-label="Reviewed">✓</span>
          </button>
        </nav>
      </aside>
      <section class="review-main">
        <div v-if="app.busy.value && !activeFile" class="empty-state">Loading merge request…</div>
        <template v-else-if="activeFile">
          <div class="file-toolbar">
            <div class="path-label"><strong>{{ fileName(activeFile) }}</strong><span v-if="activeFile.renamed_file" class="old-path">from {{ activeFile.old_path }}</span></div>
            <div class="file-actions"><button class="quiet" @click="navigate(-1)">← Previous</button><button class="quiet" @click="navigate(1)">Next unreviewed →</button><button class="quiet" :disabled="!activeFile.identity" @click="toggleReviewed">{{ isReviewed(activeFile) ? 'Mark unreviewed' : 'Mark reviewed' }}</button><label class="wrap-toggle"><input :checked="app.autoAdvance.value" type="checkbox" aria-label="Auto-advance to next unreviewed file" @change="app.setAutoAdvance(($event.target as HTMLInputElement).checked)"> Auto-advance</label><span class="toolbar-rule"/><button class="quiet" :class="{ chosen: mode === 'split' }" @click="mode = 'split'">Split</button><button class="quiet" :class="{ chosen: mode === 'unified' }" @click="mode = 'unified'">Unified</button><label class="wrap-toggle"><input v-model="wrap" type="checkbox"> Wrap</label><label class="wrap-toggle"><input v-model="continuous" type="checkbox"> Continuous</label></div>
          </div>
          <div v-if="activeFile.collapsed || activeFile.too_large" class="diff-warning"><strong>{{ activeFile.too_large ? 'GitLab marked this file as too large.' : 'GitLab collapsed this diff.' }}</strong><span>{{ activeFile.too_large ? 'Inline diff is unavailable for this file.' : 'Some context may be missing from the returned patch.' }}</span><button class="quiet" :disabled="expandingPath === fileName(activeFile)" @click="expandFile(activeFile)">{{ expandingPath === fileName(activeFile) ? 'Loading…' : 'Load full file' }}</button></div>
          <div class="diff-scroll">
            <div v-if="continuous" ref="continuousRoot" class="continuous-list">
              <article v-for="file in displayedFiles" :key="file.new_path + file.identity" :data-continuous-path="fileName(file)" :data-path="fileName(file)" class="continuous-file">
                <header><button class="quiet" @click="setFile(file)">{{ fileName(file) }}</button><button class="quiet" @click="setFile(file)">Comment on file</button></header>
                <component :is="PierreDiff" v-if="continuousVisible.has(fileName(file)) && file.diff" :diff="file.diff" :path="fileName(file)" :mode="mode" :wrap="wrap" :continuous="true" @line-selected="selectDiffLine" @line-range="selectDiffRange" />
                <pre v-else-if="continuousVisible.has(fileName(file))" class="raw-diff">GitLab did not return an inline diff for this file.</pre>
              </article>
            </div>
            <template v-else>
              <component :is="PierreDiff" v-if="selectedDiff" :key="activeFile.new_path + activeFile.identity" :diff="activeFile.diff" :path="fileName(activeFile)" :mode="mode" :wrap="wrap" :full-files="expandedFiles[fileName(activeFile)]" @line-selected="selectDiffLine" @line-range="selectDiffRange" />
              <pre v-else class="raw-diff">{{ activeFile.diff || 'GitLab did not return an inline diff for this file.' }}</pre>
            </template>
          </div>
          <div class="comment-panel">
            <section class="draft-notes" aria-label="GitLab draft notes">
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
            <details v-for="thread in discussionList" :key="thread.id" class="discussion" :open="thread.notes?.some((note: any) => note.position?.new_path === activeFile?.new_path || note.position?.old_path === activeFile?.old_path)">
              <summary>{{ thread.notes?.[0]?.author?.name || 'Review comment' }} <span>{{ thread.resolved ? 'Resolved' : '' }}</span></summary>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <article v-for="note in thread.notes || []" :key="note.id" class="note"><strong>{{ note.author?.name }}</strong><span class="note-line">{{ note.position?.new_line ? `line ${note.position.new_line}` : 'file discussion' }}</span><template v-if="editingNote === String(note.id)"><textarea v-model="editText" rows="3"/><button class="quiet" @click="saveEditedNote(thread.id, note.id)">Save edit</button><button class="quiet" @click="editingNote = ''">Cancel</button></template><div v-else class="markdown" v-html="renderMarkdown(note.body)"/><div v-if="String(note.author?.id) === String(app.review.value.user.id)" class="note-actions"><button class="quiet" @click="startEdit(note)">Edit</button><button class="quiet" @click="deleteNote(thread.id, note.id)">Delete</button></div><div class="reactions"><button v-for="emoji in reactions" :key="emoji" class="reaction" :aria-label="`React with ${emoji}`" @click="toggleReaction(note, emoji)">{{ (note.award_emoji || []).filter((award: any) => award.name === emoji).length ? `${emoji} ${(note.award_emoji || []).filter((award: any) => award.name === emoji).length}` : emoji }}</button></div></article>
              <form v-if="replyTo === thread.id" class="reply-form" @submit.prevent="sendReply(thread.id)"><textarea v-model="replyText" rows="2" aria-label="Reply to discussion" placeholder="Write a reply…" :disabled="replyBusy"/><button class="approve" :disabled="replyBusy || !replyText.trim()">{{ replyBusy ? 'Sending…' : commentDraft ? 'Save draft reply' : 'Send reply' }}</button></form><button v-else class="quiet" @click="showReply(thread.id)">Reply</button>
              <button class="quiet" @click="app.call('resolve', { discussionId: thread.id, resolved: !thread.resolved }).then(app.refresh)">{{ thread.resolved ? 'Reopen' : 'Resolve' }}</button>
            </details>
            <form class="comment-form" @submit.prevent="sendComment"><label for="review-comment">{{ inlinePosition ? 'Comment on selected diff line' : 'Add a file comment' }}<button v-if="inlinePosition" type="button" class="quiet" @click="inlinePosition = null">Clear line</button></label><textarea id="review-comment" v-model="comment" rows="3" placeholder="Write a comment…" :disabled="commentBusy"/><div class="comment-actions"><label class="wrap-toggle"><input v-model="commentDraft" type="checkbox"> Save as draft note</label><button class="approve" :disabled="commentBusy || !comment.trim()">{{ commentBusy ? 'Saving…' : commentDraft ? 'Save draft' : 'Post comment' }}</button></div></form>
          </div>
        </template>
        <div v-else class="empty-state">No changed files were returned by GitLab.</div>
      </section>
      <aside v-if="previewOpen" class="preview-pane">
        <button class="preview-resize" aria-label="Resize preview panel" @pointerdown.prevent="startPreviewResize" @keydown.left.prevent="resizePreviewBy(24)" @keydown.right.prevent="resizePreviewBy(-24)" />
        <div class="preview-toolbar"><strong>Review app</strong><select v-if="previewCandidates.length" :value="previewUrl" aria-label="Preview environment" @change="setPreview(($event.target as HTMLSelectElement).value)"><option v-if="!previewUrl" value="" disabled>Select deployment</option><option v-for="candidate in previewCandidates" :key="candidate.url" :value="candidate.url">{{ candidate.environment }} · {{ candidate.match === 'exact' ? 'exact SHA' : 'branch match, may be stale' }}</option></select><button class="quiet" :disabled="previewBusy" @click="refreshPreview">↻</button><a v-if="previewUrl" class="quiet" :href="previewUrl" target="_blank" rel="noreferrer">Open ↗</a><button class="icon-button" aria-label="Close preview" @click="previewOpen = false">×</button></div>
        <div v-if="previewBusy && !previewCandidates.length" class="preview-empty">Finding matching deployments…</div>
        <div v-else-if="!previewUrl" class="preview-empty"><strong>{{ previewCandidates.length ? 'Select a deployment' : 'No matching preview found' }}</strong><span>{{ previewCandidates.length ? 'Choose a verified deployment to open its preview.' : 'A successful deployment for this merge request was not found.' }}</span></div>
        <iframe v-else :key="previewKey" class="preview-frame" :src="previewUrl" :sandbox="'allow-scripts allow-forms allow-same-origin'" referrerpolicy="no-referrer" title="Merge request preview" />
        <p v-if="previewUrl" class="frame-note">This site may block embedding. <a :href="previewUrl" target="_blank" rel="noreferrer">Open it in your browser</a>.</p>
      </aside>
    </div>
    <div v-if="summaryOpen" class="modal-backdrop" @click.self="summaryOpen = false"><form class="modal" @submit.prevent="sendSummary"><h2>{{ summaryIntent === 'changes' ? 'Request changes' : 'Post a review summary' }}</h2><textarea v-model="summary" rows="7" :placeholder="summaryIntent === 'changes' ? 'Explain the changes you are requesting…' : 'Share an overall review note…'"/><div class="modal-actions"><button type="button" class="quiet" @click="summaryOpen = false">Cancel</button><button class="approve">{{ summaryIntent === 'changes' ? 'Post change request' : 'Post summary' }}</button></div></form></div>
  </main>
</template>
