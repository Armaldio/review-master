import { computed, ref, shallowRef } from 'vue';

export type DiffFile = { old_path: string; new_path: string; diff: string; old_id?: string; new_id?: string; new_file: boolean; deleted_file: boolean; renamed_file: boolean; collapsed?: boolean; too_large?: boolean; identity: string | null };
export type ReviewData = { mr: any; user: any; project: any; diffs: DiffFile[]; discussions: any[]; draftNotes: any[]; codeowners: any[]; ownerStatus?: Record<string, boolean | null>; ownerWarning?: string };

export function useReview() {
  const mrUrl = ref('');
  const review = shallowRef<ReviewData | null>(null);
  const selectedPath = ref('');
  const error = ref('');
  const busy = ref(false);
  const ownershipPending = ref(false);
  const refreshedAt = ref(0);
  const retryAt = ref(0);
  const backoffMs = ref(90_000);
  const drafts = ref<Record<string, string>>({});
  const reviewed = ref<Record<string, string>>({});
  const pendingReviewed = ref<Record<string, string>>({});
  const autoAdvance = ref(true);
  let bootstrapGeneration = 0;
  const files = computed(() => review.value?.diffs ?? []);
  const selected = computed(() => files.value.find(file => (file.new_file ? file.new_path : file.deleted_file ? file.old_path : file.new_path) === selectedPath.value) ?? files.value[0] ?? null);
  const storageKey = computed(() => {
    const item = review.value;
    return item ? `review-master:v3:${new URL(mrUrl.value).origin}:${item.user.id}:${item.project?.id ?? item.mr.project_id}:${item.mr.iid}` : '';
  });

  function readLocal() {
    if (!import.meta.client || !storageKey.value) return;
    try {
      const value = JSON.parse(localStorage.getItem(storageKey.value) || '{}');
      drafts.value = value.drafts && typeof value.drafts === 'object' ? value.drafts : {};
      autoAdvance.value = typeof value.autoAdvance === 'boolean' ? value.autoAdvance : true;
      const old = value.reviewed || {};
      const candidates = Object.entries(old).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
      const currentFiles = new Map(files.value.map(file => [file.deleted_file ? file.old_path : file.new_path, file]));
      const confirmed: Record<string, string> = {};
      const pending: Record<string, string> = {};
      for (const [path, sha] of candidates) {
        const file = currentFiles.get(path);
        if (!file) continue;
        if (file.identity === null) pending[path] = sha;
        else if (file.identity === sha) confirmed[path] = sha;
      }
      reviewed.value = confirmed;
      pendingReviewed.value = pending;
    } catch { drafts.value = {}; reviewed.value = {}; pendingReviewed.value = {}; error.value = 'Local review state could not be loaded from browser storage.'; }
  }
  function persist() {
    if (!import.meta.client || !storageKey.value) return;
    try { localStorage.setItem(storageKey.value, JSON.stringify({ drafts: drafts.value, reviewed: { ...pendingReviewed.value, ...reviewed.value }, autoAdvance: autoAdvance.value })); }
    catch { error.value = 'Local review state could not be saved to browser storage.'; }
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
    mrUrl.value = url;
    busy.value = true;
    try {
      const data = await call<ReviewData>('bootstrap');
      review.value = data;
      selectedPath.value ||= data.diffs[0]?.new_path || data.diffs[0]?.old_path || '';
      readLocal();
      refreshedAt.value = Date.now();
    } finally {
      busy.value = false;
      if (generation === bootstrapGeneration && !review.value) ownershipPending.value = false;
    }
  }
  async function verifyOwnership() {
    const generation = bootstrapGeneration;
    if (!review.value) return;
    const item = review.value;
    ownershipPending.value = true;
    try {
      const ownership = await call<{ codeowners: ReviewData['codeowners']; ownerStatus: Record<string, boolean | null>; ownerWarning?: string }>('verify-owners', {
        paths: item.diffs.map(file => file.deleted_file ? file.old_path : file.new_path),
        targetBranch: item.mr.target_branch,
      });
      if (generation === bootstrapGeneration && review.value) review.value = { ...review.value, ...ownership };
    } catch {
      if (generation === bootstrapGeneration && review.value) review.value = { ...review.value, ownerWarning: 'CODEOWNERS owners could not be verified; showing all files.' };
    } finally {
      if (generation === bootstrapGeneration) ownershipPending.value = false;
    }
  }
  async function hydrateIdentities() {
    const generation = bootstrapGeneration;
    const item = review.value;
    if (!item) return;
    const paths = item.diffs.filter(file => !file.deleted_file && !file.identity).map(file => file.new_path);
    if (!paths.length) return;
    const result = await call<{ identities: Record<string, string | null> }>('file-identities', { paths, sha: item.mr.sha });
    if (!review.value || generation !== bootstrapGeneration) return;
    const current = review.value;
    const diffs = current.diffs.map(file => {
      const path = file.deleted_file ? file.old_path : file.new_path;
      const identity = result.identities[path];
      return identity ? { ...file, identity } : file;
    });
    review.value = { ...current, diffs };

    const currentFiles = new Map(diffs.map(file => [file.deleted_file ? file.old_path : file.new_path, file]));
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
    persist();
  }
  async function refresh(force = false) {
    if (!review.value || busy.value || (!force && Date.now() < retryAt.value)) return;
    busy.value = true;
    try {
      const updated = await call<any>('refresh');
      const current = review.value.mr;
      const oldDiffIdentity = `${current.sha}:${current.diff_refs?.base_sha || ''}:${current.diff_refs?.head_sha || ''}:${current.diff_refs?.start_sha || ''}`;
      const nextDiffIdentity = `${updated.mr.sha}:${updated.mr.diff_refs?.base_sha || ''}:${updated.mr.diff_refs?.head_sha || ''}:${updated.mr.diff_refs?.start_sha || ''}`;
      if (nextDiffIdentity !== oldDiffIdentity) {
        await bootstrap(mrUrl.value);
        if (review.value) review.value = { ...review.value, mr: updated.mr, discussions: updated.discussions, draftNotes: updated.draftNotes };
      } else review.value = { ...review.value, mr: updated.mr, discussions: updated.discussions, draftNotes: updated.draftNotes };
      refreshedAt.value = Date.now();
    } catch { /* error is visible in the review header */
    } finally { busy.value = false; }
  }
  function setDraft(key: string, value: string) { drafts.value = { ...drafts.value, [key]: value }; persist(); }
  function setReviewed(file: DiffFile, value: boolean) {
    const path = file.new_file ? file.new_path : file.deleted_file ? file.old_path : file.new_path;
    if (!file.identity) return;
    pendingReviewed.value = Object.fromEntries(Object.entries(pendingReviewed.value).filter(([key]) => key !== path));
    reviewed.value = value
      ? { ...reviewed.value, [path]: file.identity }
      : Object.fromEntries(Object.entries(reviewed.value).filter(([key]) => key !== path)) as Record<string, string>;
    persist();
  }
  function setAutoAdvance(value: boolean) { autoAdvance.value = value; persist(); }
  return { mrUrl, review, files, selectedPath, selected, error, busy, ownershipPending, refreshedAt, retryAt, drafts, reviewed, autoAdvance, call, bootstrap, verifyOwnership, hydrateIdentities, refresh, setDraft, setReviewed, setAutoAdvance };
}
