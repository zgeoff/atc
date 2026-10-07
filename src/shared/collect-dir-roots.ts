import { isRecord } from './report';
import { resolveHomeDir } from './resolve-home-dir';

/**
 * Reads `dirs.roots`: the directories whose children the spawn picker
 * lists. A non-string entry is dropped, a leading `~` expands to the home
 * directory, and trailing slashes are trimmed so a root compares equal to
 * the paths under it. `home` is the directory a `~` expands to.
 */
export function collectDirRoots(raw: unknown, home: string = resolveHomeDir()): readonly string[] {
  if (!isRecord(raw) || !Array.isArray(raw['roots'])) {
    return [];
  }

  const roots: string[] = [];

  for (const item of raw['roots']) {
    if (typeof item !== 'string' || item === '') {
      continue;
    }

    roots.push(normalizeRoot(item, home));
  }

  return roots;
}

function normalizeRoot(dir: string, home: string): string {
  const expanded = dir === '~' ? home : dir.replace(/^~\//u, `${home}/`);
  const trimmed = expanded.replace(/\/+$/u, '');

  return trimmed === '' ? '/' : trimmed;
}
