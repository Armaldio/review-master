export type CodeownerRule = { pattern: string; owners: string[]; section?: string; exclude?: boolean };
export type ParsedCodeowners = { rules: CodeownerRule[]; warning?: string };

export function parseCodeowners(source: string): ParsedCodeowners {
  const rules: CodeownerRule[] = [];
  let section = '';
  let sectionOwners: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const heading = line.match(/^\^?\[([^\]]+)\](?:\[\d+\])?(?:\s+(.+))?$/);
    if (heading) {
      section = heading[1]!.trim();
      sectionOwners = heading[2]?.trim().split(/\s+/).filter(Boolean) || [];
      continue;
    }
    const parts = line.split(/\s+/);
    const pattern = parts.shift()!;
    if (pattern.startsWith('!')) {
      if (pattern.length === 1 || parts.length) return { rules: [], warning: 'CODEOWNERS contains unsupported syntax; showing all files.' };
      rules.push({ pattern: pattern.slice(1), owners: [], exclude: true, ...(section ? { section } : {}) });
    } else {
      // A section's defaults apply only to explicit patterns in that section.
      // Keeping owners on each rule prevents defaults leaking to other sections.
      rules.push({ pattern, owners: parts.length ? parts : [...sectionOwners], ...(section ? { section } : {}) });
    }
  }
  return { rules };
}

export function codeownersForPath(rules: CodeownerRule[], path: string) {
  const bySection = new Map<string, { rule?: CodeownerRule; excluded: boolean }>();
  for (const rule of rules) {
    if (!globMatches(rule.pattern, path)) continue;
    const section = rule.section || '';
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
