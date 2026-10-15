type DiffFile = { old_path: string; new_path: string; diff: string; collapsed?: boolean; too_large?: boolean };

export type CommentableDiffLines = {
  old_path: string;
  new_path: string;
  old_lines: number[];
  new_lines: number[];
};

function changedLines(diff: string) {
  const oldLines = new Set<number>();
  const newLines = new Set<number>();
  let oldLine: number | null = null;
  let newLine: number | null = null;

  for (const line of diff.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (oldLine !== null && newLine !== null && line.startsWith('+') && !line.startsWith('+++')) {
      newLines.add(newLine++);
    } else if (oldLine !== null && newLine !== null && line.startsWith('-') && !line.startsWith('---')) {
      oldLines.add(oldLine++);
    } else if (oldLine !== null && newLine !== null && line.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
  }

  return { oldLines, newLines };
}

function fileKey(file: Pick<DiffFile, 'old_path' | 'new_path'>) {
  return JSON.stringify([file.old_path, file.new_path]);
}

/** Return changed line coordinates from an incremental diff that also exist in GitLab's stored MR version diff. */
export function commentableLinesForDelta(delta: DiffFile[], officialVersion: DiffFile[]): CommentableDiffLines[] {
  const officialByPath = new Map(officialVersion
    .filter(file => !file.collapsed && !file.too_large)
    .map(file => [fileKey(file), changedLines(file.diff)]));

  return delta.map(file => {
    const deltaLines = changedLines(file.diff);
    const officialLines = officialByPath.get(fileKey(file));
    return {
      old_path: file.old_path,
      new_path: file.new_path,
      old_lines: officialLines ? [...deltaLines.oldLines].filter(line => officialLines.oldLines.has(line)) : [],
      new_lines: officialLines ? [...deltaLines.newLines].filter(line => officialLines.newLines.has(line)) : [],
    };
  });
}
