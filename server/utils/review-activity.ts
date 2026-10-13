type ActivityMr = { sha?: string; diff_refs?: { head_sha?: string } };
type ActivityNote = { id?: number | string; system?: boolean };
type ActivityDiscussion = { notes?: ActivityNote[] };

export function createReviewActivityLogger(emit: (message: string) => void) {
  const snapshots = new Map<string, { sha: string; noteIds: Set<string> }>();

  return (key: string, mr: ActivityMr, discussions: ActivityDiscussion[]) => {
    const sha = mr.sha || mr.diff_refs?.head_sha || '';
    const noteIds = new Set(discussions.flatMap(discussion => (discussion.notes || [])
      .filter(note => !note.system && note.id != null)
      .map(note => String(note.id))));
    const previous = snapshots.get(key);

    if (previous) {
      if (sha && previous.sha && sha !== previous.sha) emit(`MergePeek: new commit ${sha.slice(0, 8)}`);
      const added = [...noteIds].filter(id => !previous.noteIds.has(id)).length;
      if (added) emit(`MergePeek: ${added} new comment${added === 1 ? '' : 's'}`);
    }

    snapshots.delete(key);
    snapshots.set(key, { sha, noteIds });
    if (snapshots.size > 100) snapshots.delete(snapshots.keys().next().value!);
  };
}

export const logReviewActivity = createReviewActivityLogger(message => process.stdout.write(`${message}\n`));
