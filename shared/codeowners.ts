export type CodeownerRule = { pattern: string; owners: string[]; section?: string; exclude?: boolean };

export function codeownersForPath(rules: CodeownerRule[], path: string) {
  const bySection = new Map<string, { rule?: CodeownerRule; excluded: boolean }>();
  for (const rule of rules) {
    if (!globMatches(rule.pattern, path)) continue;
    const section = rule.section || '';
    if (bySection.get(section)?.excluded) continue;
    if (rule.exclude) bySection.set(section, { excluded: true });
    else bySection.set(section, { rule, excluded: false });
  }
  return {
    matched: bySection.size > 0,
    owners: [...bySection.values()].flatMap(entry => entry.excluded || !entry.rule ? [] : entry.rule.owners),
  };
}

export function globMatches(pattern: string, path: string) {
  if (!pattern) return false;
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
  if (!anchored) re = `(?:.*/)?${re}`;
  return new RegExp(`^${re}${directory ? '(?:/.*)?' : ''}$`).test(path);
}
