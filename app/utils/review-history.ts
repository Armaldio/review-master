export type VersionEntry = { id: number };
export type VersionFile = { old_path: string; new_path: string; identity: string | null; deleted_file: boolean };

const pathFor = (file: VersionFile) => file.deleted_file ? file.old_path : file.new_path;

export function latestVersionId(versions: VersionEntry[]): number | null {
  return versions[0]?.id ?? null;
}

export function reconcileVersions<T extends VersionEntry>(current: T[], incoming: T[], selectedVersionId: number | null) {
  const knownIds = new Set(current.map(version => version.id));
  return {
    versions: incoming,
    selectedVersionId,
    addedVersionIds: incoming.filter(version => !knownIds.has(version.id)).map(version => version.id),
    selectedStillAvailable: incoming.some(version => version.id === selectedVersionId),
  };
}

export function pathForSelectedVersion(previousPath: string, files: VersionFile[]): string {
  if (files.some(file => pathFor(file) === previousPath)) return previousPath;
  return files[0] ? pathFor(files[0]) : '';
}

export function versionReviewStatus(
  versionId: number,
  selectedVersionId: number | null,
  files: VersionFile[],
  reviewed: Record<string, string>,
  reviewedByVersion: Record<string, Record<string, string>>,
  completedVersions: Record<string, boolean>,
): 'reviewed' | 'in-progress' | 'not-reviewed' | 'no-changes' {
  const key = String(versionId);
  if (selectedVersionId === versionId) {
    if (!files.length) return 'no-changes';
    if (files.every(file => Boolean(file.identity) && reviewed[pathFor(file)] === file.identity)) return 'reviewed';
    if (files.some(file => Boolean(file.identity) && reviewed[pathFor(file)] === file.identity)) return 'in-progress';
  }
  if (completedVersions[key]) return 'reviewed';
  if (Object.keys(reviewedByVersion[key] || {}).length) return 'in-progress';
  return 'not-reviewed';
}
