import { nextTick, ref } from 'vue';
import type { useReview } from './useReview';

export type ZenPanel = 'files' | 'controls' | 'history' | 'activity';
export type MrCommit = { id: string; short_id?: string; title: string; author_name?: string; committed_date?: string; authored_date?: string; web_url?: string };
export type CommitInspection = { commit: MrCommit; files: any[] };

type Review = ReturnType<typeof useReview>;

export function useZenReview(app: Review, closeActionMenu: () => void, fileName: (file: any) => string) {
  const zenMode = ref(false);
  const zenPanel = ref<ZenPanel | null>(null);
  const zenHistoryTab = ref<'commits' | 'revisions'>('revisions');
  const commits = ref<MrCommit[]>([]);
  const commitsLoading = ref(false);
  const commitsLoaded = ref(false);
  const commitsFailed = ref(false);
  const commitInspection = ref<CommitInspection | null>(null);
  const selectedCommitPath = ref('');
  const commitDiffLoading = ref(false);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverOpenedPanel: ZenPanel | null = null;
  let commitRequestId = 0;

  function closeZenActionMenu(event: Event) {
    (event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open');
  }
  function clearZenCloseTimer() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = undefined;
  }
  function openZenPanel(panel: ZenPanel) {
    if (!zenMode.value) return;
    clearZenCloseTimer();
    if (zenPanel.value !== panel) hoverOpenedPanel = null;
    zenPanel.value = panel;
  }
  function closeZenPanel(returnFocus = false) {
    const panel = zenPanel.value;
    if (!panel) return;
    clearZenCloseTimer();
    hoverOpenedPanel = null;
    zenPanel.value = null;
    if (returnFocus) void nextTick(() => document.getElementById(`zen-edge-${panel}`)?.focus());
  }
  function focusZenPanel(panel: ZenPanel) {
    const root = document.getElementById(`zen-${panel}-panel`);
    const target = root?.querySelector<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    target?.focus();
  }
  function toggleZenPanel(panel: ZenPanel, event: MouseEvent) {
    if (hoverOpenedPanel === panel && zenPanel.value === panel) {
      hoverOpenedPanel = null;
      return;
    }
    if (zenPanel.value === panel) closeZenPanel();
    else {
      openZenPanel(panel);
      if (event.detail === 0) void nextTick(() => focusZenPanel(panel));
    }
  }
  function onZenHandlePointerEnter(panel: ZenPanel, event: PointerEvent) {
    if (event.pointerType !== 'mouse' || zenPanel.value === panel) return;
    openZenPanel(panel);
    hoverOpenedPanel = panel;
  }
  function hasZenPanelFocus(panel: ZenPanel) {
    const active = document.activeElement;
    return Boolean(active && (
      document.getElementById(`zen-${panel}-panel`)?.contains(active)
      || document.getElementById(`zen-edge-${panel}`)?.contains(active)
    ));
  }
  function scheduleZenPanelClose(panel: ZenPanel) {
    clearZenCloseTimer();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    closeTimer = setTimeout(() => {
      if (zenPanel.value === panel && !hasZenPanelFocus(panel)) zenPanel.value = null;
      closeTimer = undefined;
    }, reducedMotion ? 0 : 450);
  }
  function onZenHandlePointerLeave(panel: ZenPanel, event: PointerEvent) {
    if (event.pointerType !== 'mouse') return;
    if (hoverOpenedPanel === panel) hoverOpenedPanel = null;
    scheduleZenPanelClose(panel);
  }
  function onZenPanelPointerEnter(_panel: ZenPanel, event: PointerEvent) {
    if (event.pointerType === 'mouse') clearZenCloseTimer();
  }
  function onZenPanelPointerLeave(panel: ZenPanel, event: PointerEvent) {
    if (event.pointerType === 'mouse') scheduleZenPanelClose(panel);
  }
  function onZenPanelFocusOut(panel: ZenPanel, event: FocusEvent) {
    const next = event.relatedTarget;
    if (next instanceof Element && (
      document.getElementById(`zen-${panel}-panel`)?.contains(next)
      || document.getElementById(`zen-edge-${panel}`)?.contains(next)
    )) return;
    scheduleZenPanelClose(panel);
  }
  function onZenKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !zenMode.value || !zenPanel.value) return;
    event.preventDefault();
    event.stopPropagation();
    closeZenPanel(true);
  }
  function toggleZenMode() {
    closeZenPanel();
    closeActionMenu();
    zenMode.value = !zenMode.value;
  }
  async function loadCommits(force = false) {
    if (commitsLoading.value || commitsLoaded.value && !force) return;
    commitsLoading.value = true;
    commitsFailed.value = false;
    try {
      const result = await app.call<MrCommit[]>('mr-commits');
      if (!Array.isArray(result)) throw new Error('GitLab returned an invalid commit list.');
      commits.value = result.filter(commit => typeof commit?.id === 'string' && /^[a-f\d]{40}$/i.test(commit.id) && typeof commit.title === 'string');
      commitsLoaded.value = true;
    } catch { commitsFailed.value = true; }
    finally { commitsLoading.value = false; }
  }
  function commitTime(commit: MrCommit) {
    const value = commit.committed_date || commit.authored_date || '';
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
      ? { label: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp), datetime: value }
      : { label: 'Time unavailable', datetime: undefined };
  }
  async function inspectCommit(commit: MrCommit) {
    if (commitDiffLoading.value || commitInspection.value?.commit.id === commit.id) return;
    const requestId = ++commitRequestId;
    commitDiffLoading.value = true;
    try {
      const result = await app.call<{ commitId: string; diffs: any[] }>('commit-diff', { sha: commit.id });
      if (requestId !== commitRequestId || zenHistoryTab.value !== 'commits') return;
      if (result.commitId !== commit.id || !Array.isArray(result.diffs)) {
        app.error.value = 'GitLab returned a different or invalid commit diff. Select the commit again to retry.';
        return;
      }
      commitInspection.value = { commit, files: result.diffs };
      selectedCommitPath.value = result.diffs[0] ? fileName(result.diffs[0]) : '';
    } catch { /* error is shown in the header */ }
    finally { if (requestId === commitRequestId) commitDiffLoading.value = false; }
  }
  function returnToSelectedRevision() {
    commitRequestId++;
    commitDiffLoading.value = false;
    commitInspection.value = null;
    selectedCommitPath.value = '';
    if (zenMode.value) zenHistoryTab.value = 'revisions';
  }
  function selectZenHistoryTab(tab: 'commits' | 'revisions') {
    zenHistoryTab.value = tab;
    if (tab === 'commits') void loadCommits();
    else returnToSelectedRevision();
  }

  return {
    zenMode, zenPanel, zenHistoryTab, commits, commitsLoading, commitsLoaded, commitsFailed,
    commitInspection, selectedCommitPath, commitDiffLoading,
    clearZenCloseTimer, closeZenActionMenu, closeZenPanel, commitTime, inspectCommit,
    loadCommits, onZenHandlePointerEnter, onZenHandlePointerLeave, onZenKeydown,
    onZenPanelFocusOut, onZenPanelPointerEnter, onZenPanelPointerLeave,
    returnToSelectedRevision, selectZenHistoryTab, toggleZenMode, toggleZenPanel,
  };
}
