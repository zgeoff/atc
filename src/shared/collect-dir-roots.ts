import { homedir } from 'node:os';
import { isRecord } from './report';

/**
 * Reads `dirs.roots`: the directories whose children the spawn picker
 * lists. A non-string entry is dropped, a leading `~` expands to the home
 * directory, and trailing slashes are trimmed so a root compares equal to
 * the paths under it.
 */
export function collectDirRoots(raw: unknown): readonly string[] {
  if (!isRecord(raw) || !Array.isArray(raw['roots'])) {
    return [];
  }

  const roots: string[] = [];

  for (const item of raw['roots']) {
    if (typeof item !== 'string' || item === '') {
      continue;
    }

    roots.push(normalizeRoot(item));
  }

  return roots;
}

function normalizeRoot(dir: string): string {
  const expanded = dir === '~' ? homedir() : dir.replace(/^~\//u, `${homedir()}/`);
  const trimmed = expanded.replace(/\/+$/u, '');

  return trimmed === '' ? '/' : trimmed;
}
