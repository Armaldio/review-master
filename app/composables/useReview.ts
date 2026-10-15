import { computed, ref, shallowRef } from 'vue';
import { latestVersionId as findLatestVersionId, pathForSelectedVersion, reconcileVersions, versionReviewStatus as getVersionReviewStatus } from '../utils/review-history.ts';

export type DiffFile = { old_path: string; new_path: string; diff: string; old_id?: string; new_id?: string; new_file: boolean; deleted_file: boolean; renamed_file: boolean; collapsed?: boolean; too_large?: boolean; identity: string | null };
export type DiffVersion = { id: number; created_at: string; head_commit_sha: string; base_commit_sha: string; start_commit_sha: string; state?: string; real_size?: string };
export type ReviewData = { mr: any; user: any; project: any; diffs: DiffFile[]; versions: DiffVersion[]; selectedVersionId: number; versionIsInitial: boolean; versionIsLatest?: boolean; commentRefs?: { base_sha: string; head_sha: string; start_sha: string }; commentableLines?: Array<{ old_path: string; new_path: string; old_lines: number[]; new_lines: number[] }>; discussions: any[]; draftNotes: any[]; codeowners: any[]; ownerStatus?: Record<string, boolean | null>; ownerWarning?: string };

const fileName = (file: DiffFile) => file.deleted_file ? file.old_path : file.new_path;

export function useReview() {
  const mrUrl = ref('');
  const review = shallowRef<ReviewData | null>(null);
  const selectedPath = ref('');
  const selectedVersionId = ref<number | null>(null);
  const error = ref('');
  const busy = ref(false);
  const ownershipPending = ref(false);
  const membershipCheckedAt = ref<string | null>(null);
  const refreshedAt = ref(0);
  const retryAt = ref(0);
  const backoffMs = ref(90_000);
  const drafts = ref<Record<string, string>>({});
  const reviewed = ref<Record<string, string>>({});
  const pendingReviewed = ref<Record<string, string>>({});
  const reviewedByVersion = ref<Record<string, Record<string, string>>>({});
  const completedVersions = ref<Record<string, boolean>>({});
  const seenVersions = ref<Record<string, boolean>>({});
  const addedVersionIds = ref<number[]>([]);
  const autoAdvance = ref(true);
  let bootstrapGeneration = 0;
  const files = computed(() => review.value?.diffs ?? []);
  const versions = computed(() => review.value?.versions ?? []);
  const latestVersionId = computed(() => findLatestVersionId(versions.value));
  const unreadVersions = computed(() => versions.value.filter(version => !seenVersions.value[String(version.id)]));
  const selected = computed(() => files.value.find(file => fileName(file) === selectedPath.value) ?? files.value[0] ?? null);
  const storageKey = computed(() => {
    const item = review.value;
    return item ? `review-master:v3:${new URL(mrUrl.value).origin}:${item.user.id}:${item.project?.id ?? item.mr.project_id}:${item.mr.iid}` : '';
  });

  function currentReviewMap() {
    return { ...pendingReviewed.value, ...reviewed.value };
  }
  function persist() {
    if (!import.meta.client || !storageKey.value) return;
    try {
      const allReviews = { ...reviewedByVersion.value };
      const key = selectedVersionId.value == null ? '' : String(selectedVersionId.value);
      if (key) allReviews[key] = currentReviewMap();
      localStorage.setItem(storageKey.value, JSON.stringify({
        drafts: drafts.value,
        reviewed: currentReviewMap(),
        reviewedByVersion: allReviews,
        completedVersions: Object.keys(completedVersions.value).filter(id => completedVersions.value[id]),
        seenVersionIds: Object.keys(seenVersions.value).filter(id => seenVersions.value[id]),
        autoAdvance: autoAdvance.value,
      }));
    } catch { error.value = 'Local review state could not be saved to browser storage.'; }
  }
  function restoreReviewForVersion(versionId: number) {
    const key = String(versionId);
    const saved = reviewedByVersion.value[key] || {};
    const currentFiles = new Map(files.value.map(file => [fileName(file), file]));
    const confirmed: Record<string, string> = {};
    const pending: Record<string, string> = {};
    for (const [path, sha] of Object.entries(saved)) {
      const file = currentFiles.get(path);
      if (!file) continue;
      if (file.identity === null) pending[path] = sha;
      else if (file.identity === sha) confirmed[path] = sha;
    }
    reviewed.value = confirmed;
    pendingReviewed.value = pending;
    if (files.value.length && !files.value.some(file => file.identity === null)) {
      const complete = files.value.every(file => Boolean(file.identity) && confirmed[fileName(file)] === file.identity);
      completedVersions.value = { ...completedVersions.value, [key]: complete };
    }
  }
  function markVersionSeen(versionId: number) {
    seenVersions.value = { ...seenVersions.value, [String(versionId)]: true };
    persist();
  }
  function readLocal() {
    if (!import.meta.client || !storageKey.value || selectedVersionId.value == null) return;
    try {
      const value = JSON.parse(localStorage.getItem(storageKey.value) || '{}');
      drafts.value = value.drafts && typeof value.drafts === 'object' ? value.drafts : {};
      autoAdvance.value = typeof value.autoAdvance === 'boolean' ? value.autoAdvance : true;
      reviewedByVersion.value = value.reviewedByVersion && typeof value.reviewedByVersion === 'object' ? value.reviewedByVersion : {};
      completedVersions.value = Object.fromEntries((Array.isArray(value.completedVersions) ? value.completedVersions : []).map((id: string) => [String(id), true]));
      seenVersions.value = Object.fromEntries((Array.isArray(value.seenVersionIds) ? value.seenVersionIds : []).map((id: string) => [String(id), true]));
      const key = String(selectedVersionId.value);
      if (!Object.hasOwn(reviewedByVersion.value, key) && value.reviewed && typeof value.reviewed === 'object') {
        // Migrate file-level progress from earlier releases; identity checks below keep changed files unreviewed.
        reviewedByVersion.value = { ...reviewedByVersion.value, [key]: value.reviewed };
      }
      restoreReviewForVersion(selectedVersionId.value);
      markVersionSeen(selectedVersionId.value);
    } catch {
      drafts.value = {};
      reviewed.value = {};
      pendingReviewed.value = {};
      reviewedByVersion.value = {};
      error.value = 'Local review state could not be loaded from browser storage.';
    }
  }
  async function call<T = any>(action: string, payload?: Record<string, unknown>): Promise<T> {
    error.value = '';
    try { return await $fetch('/api/gitlab', { method: 'POST', body: { mrUrl: mrUrl.value, action, payload } }) as T; }
    catch (cause: any) {
      error.value = cause?.data?.statusMessage || cause?.message || 'Request failed';
      if ((cause?.statusCode || cause?.status || cause?.data?.statusCode) === 429) {
        const retryAfter = cause?.data?.data?.retryAfter || cause?.data?.retryAfter;
        const seconds = Number(retryAfter);
        const serverDelay = !retryAfter ? 0 : Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Math.max(0, Date.parse(String(retryAfter)) - Date.now());
        retryAt.value = Date.now() + Math.max(serverDelay, backoffMs.value);
        backoffMs.value = Math.min(backoffMs.value * 2, 15 * 60_000);
      }
      throw cause;
    }
    finally { if (!error.value) { retryAt.value = 0; backoffMs.value = 90_000; } }
  }
  async function bootstrap(url: string) {
    const generation = ++bootstrapGeneration;
    ownershipPending.value = true;
    membershipCheckedAt.value = null;
    mrUrl.value = url;
    busy.value = true;
    try {
      const data = await call<ReviewData>('bootstrap');
      review.value = data;
      selectedVersionId.value = data.selectedVersionId;
      selectedPath.value = data.diffs[0] ? fileName(data.diffs[0]) : '';
      addedVersionIds.value = [];
      readLocal();
      refreshedAt.value = Date.now();
    } finally {
      busy.value = false;
      if (generation === bootstrapGeneration && !review.value) ownershipPending.value = false;
    }
  }
  async function selectVersion(versionId: number): Promise<boolean> {
    if (!review.value || busy.value) return false;
    if (selectedVersionId.value === versionId) { markVersionSeen(versionId); return true; }
    busy.value = true;
    try {
      const data = await call<Pick<ReviewData, 'mr' | 'diffs' | 'versions' | 'selectedVersionId' | 'versionIsInitial' | 'versionIsLatest' | 'commentRefs' | 'commentableLines'>>('version-diff', { versionId });
      const previousPath = selectedPath.value;
      review.value = { ...review.value, ...data };
      selectedVersionId.value = data.selectedVersionId;
      restoreReviewForVersion(data.selectedVersionId);
      selectedPath.value = pathForSelectedVersion(previousPath, data.diffs);
      addedVersionIds.value = [];
      markVersionSeen(data.selectedVersionId);
      refreshedAt.value = Date.now();
      return true;
    } catch { return false; }
    finally { busy.value = false; }
  }
  async function verifyOwnership(refreshMemberships = false) {
    const generation = bootstrapGeneration;
    const versionId = selectedVersionId.value;
    if (!review.value) return;
    const item = review.value;
    ownershipPending.value = true;
    try {
      const ownership = await call<{ codeowners: ReviewData['codeowners']; ownerStatus: Record<string, boolean | null>; ownerWarning?: string; membershipCheckedAt?: string | null }>('verify-owners', {
        paths: item.diffs.map(file => file.deleted_file ? file.old_path : file.new_path),
        targetBranch: item.mr.target_branch,
        refreshMemberships,
      });
      if (generation === bootstrapGeneration && selectedVersionId.value === versionId && review.value) {
        const { membershipCheckedAt: checkedAt, ...reviewOwnership } = ownership;
        review.value = { ...review.value, ...reviewOwnership };
        membershipCheckedAt.value = checkedAt || null;
      }
    } catch {
      if (generation === bootstrapGeneration && selectedVersionId.value === versionId && review.value) {
        review.value = { ...review.value, ownerStatus: {}, ownerWarning: 'CODEOWNERS owners could not be verified; Only my files may be incomplete.' };
        if (refreshMemberships) membershipCheckedAt.value = null;
      }
    } finally {
      if (generation === bootstrapGeneration) ownershipPending.value = false;
    }
  }
  async function refreshMemberships() {
    if (ownershipPending.value) return;
    await verifyOwnership(true);
  }
  async function hydrateIdentities() {
    const generation = bootstrapGeneration;
    const item = review.value;
    if (!item) return;
    const paths = item.diffs.filter(file => !file.deleted_file && !file.identity).map(file => file.new_path);
    if (!paths.length) return;
    const result = await call<{ identities: Record<string, string | null> }>('file-identities', { paths, sha: item.mr.sha });
    if (!review.value || generation !== bootstrapGeneration || item.selectedVersionId !== selectedVersionId.value) return;
    const current = review.value;
    const diffs = current.diffs.map(file => {
      const path = file.deleted_file ? file.old_path : file.new_path;
      const identity = result.identities[path];
      return identity ? { ...file, identity } : file;
    });
    review.value = { ...current, diffs };

    const currentFiles = new Map(diffs.map(file => [fileName(file), file]));
    const confirmed = { ...reviewed.value };
    const pending = Object.fromEntries(Object.entries(pendingReviewed.value).filter(([path, sha]) => {
      const file = currentFiles.get(path);
      if (!file) return false;
      if (file.identity !== null) {
        if (file.identity === sha) confirmed[path] = sha;
        return false;
      }
      return true;
    }));
    pendingReviewed.value = pending;
    reviewed.value = confirmed;
    updateVersionCompletion();
    persist();
  }
  function updateVersionCompletion() {
    const key = selectedVersionId.value == null ? '' : String(selectedVersionId.value);
    if (!key || !files.value.length || files.value.some(file => file.identity === null)) return;
    const complete = files.value.every(file => Boolean(file.identity) && reviewed.value[fileName(file)] === file.identity);
    completedVersions.value = { ...completedVersions.value, [key]: complete };
  }
  async function refresh(force = false) {
    if (!review.value || busy.value || (!force && Date.now() < retryAt.value)) return;
    busy.value = true;
    try {
      const updated = await call<any>('refresh');
      const current = review.value;
      if (!current) return;
      const versionUpdate = reconcileVersions(current.versions, updated.versions || current.versions, selectedVersionId.value);
      addedVersionIds.value = versionUpdate.addedVersionIds;
      review.value = {
        ...current,
        mr: { ...updated.mr, sha: current.mr.sha, diff_refs: current.mr.diff_refs },
        versions: versionUpdate.versions,
        discussions: updated.discussions,
        draftNotes: updated.draftNotes,
      };
      if (!versionUpdate.selectedStillAvailable) error.value = 'The selected historical version is no longer available. Its loaded diff remains open; select an available version from History.';
      refreshedAt.value = Date.now();
    } catch { /* error is visible in the review header */
    } finally { busy.value = false; }
  }
  function setDraft(key: string, value: string) { drafts.value = { ...drafts.value, [key]: value }; persist(); }
  function setReviewed(file: DiffFile, value: boolean) {
    const path = fileName(file);
    const versionKey = selectedVersionId.value == null ? '' : String(selectedVersionId.value);
    if (!file.identity || !versionKey) return;
    pendingReviewed.value = Object.fromEntries(Object.entries(pendingReviewed.value).filter(([key]) => key !== path));
    reviewed.value = value
      ? { ...reviewed.value, [path]: file.identity }
      : Object.fromEntries(Object.entries(reviewed.value).filter(([key]) => key !== path)) as Record<string, string>;
    reviewedByVersion.value = { ...reviewedByVersion.value, [versionKey]: currentReviewMap() };
    updateVersionCompletion();
    persist();
  }
  function versionReviewStatus(versionId: number): 'reviewed' | 'in-progress' | 'not-reviewed' | 'no-changes' {
    return getVersionReviewStatus(versionId, selectedVersionId.value, files.value, reviewed.value, reviewedByVersion.value, completedVersions.value);
  }
  function setAutoAdvance(value: boolean) { autoAdvance.value = value; persist(); }
  return { mrUrl, review, files, versions, selectedVersionId, latestVersionId, unreadVersions, addedVersionIds, selectedPath, selected, error, busy, ownershipPending, membershipCheckedAt, refreshedAt, retryAt, drafts, reviewed, autoAdvance, call, bootstrap, selectVersion, verifyOwnership, refreshMemberships, hydrateIdentities, refresh, setDraft, setReviewed, versionReviewStatus, setAutoAdvance };
}
