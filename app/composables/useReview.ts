import { computed, ref, shallowRef } from 'vue';

export type DiffFile = { old_path: string; new_path: string; diff: string; old_id?: string; new_id?: string; new_file: boolean; deleted_file: boolean; renamed_file: boolean; collapsed?: boolean; too_large?: boolean; identity: string | null };
export type ReviewData = { mr: any; user: any; project: any; diffs: DiffFile[]; discussions: any[]; codeowners: any[]; ownerStatus?: Record<string, boolean | null>; ownerWarning?: string };

export function useReview() {
  const mrUrl = ref('');
  const review = shallowRef<ReviewData | null>(null);
  const selectedPath = ref('');
  const error = ref('');
  const busy = ref(false);
  const refreshedAt = ref(0);
  const retryAt = ref(0);
  const backoffMs = ref(90_000);
  const drafts = ref<Record<string, string>>({});
  const reviewed = ref<Record<string, string>>({});
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
      drafts.value = value.drafts || {};
      const old = value.reviewed || {};
      reviewed.value = Object.fromEntries(Object.entries(old).filter(([path, sha]) => typeof sha === 'string' && files.value.some(file => (file.deleted_file ? file.old_path : file.new_path) === path && file.identity && file.identity === sha))) as Record<string, string>;
    } catch { drafts.value = {}; reviewed.value = {}; }
  }
  function persist() {
    if (!import.meta.client || !storageKey.value) return;
    localStorage.setItem(storageKey.value, JSON.stringify({ drafts: drafts.value, reviewed: reviewed.value }));
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
    mrUrl.value = url;
    busy.value = true;
    try {
      const data = await call<ReviewData>('bootstrap');
      review.value = data;
      selectedPath.value ||= data.diffs[0]?.new_path || data.diffs[0]?.old_path || '';
      readLocal();
      refreshedAt.value = Date.now();
    } finally { busy.value = false; }
  }
  async function refresh(force = false) {
    if (!review.value || busy.value || (!force && Date.now() < retryAt.value)) return;
    busy.value = true;
    try {
      const updated = await call<any>('refresh');
      const current = review.value.mr;
      const oldDiffIdentity = `${current.sha}:${current.diff_refs?.base_sha || ''}:${current.diff_refs?.head_sha || ''}:${current.diff_refs?.start_sha || ''}`;
      const nextDiffIdentity = `${updated.mr.sha}:${updated.mr.diff_refs?.base_sha || ''}:${updated.mr.diff_refs?.head_sha || ''}:${updated.mr.diff_refs?.start_sha || ''}`;
      review.value = { ...review.value, mr: updated.mr, discussions: updated.discussions };
      if (nextDiffIdentity !== oldDiffIdentity) await bootstrap(mrUrl.value);
      refreshedAt.value = Date.now();
    } catch { /* error is visible in the review header */
    } finally { busy.value = false; }
  }
  function setDraft(key: string, value: string) { drafts.value = { ...drafts.value, [key]: value }; persist(); }
  function markReviewed(file: DiffFile) {
    const path = file.new_file ? file.new_path : file.deleted_file ? file.old_path : file.new_path;
    if (file.identity) reviewed.value = { ...reviewed.value, [path]: file.identity };
    persist();
  }
  return { mrUrl, review, files, selectedPath, selected, error, busy, refreshedAt, retryAt, drafts, reviewed, call, bootstrap, refresh, setDraft, markReviewed };
}
