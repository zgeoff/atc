import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';

// Spawn-history first (most recently used, reported by the daemon), then
// zoxide's frecency list.
export async function collectDirs(recent: readonly string[]): Promise<string[]> {
  let zoxide: string[] = [];

  try {
    const proc = Bun.spawn(['zoxide', 'query', '-l'], { stdout: 'pipe', stderr: 'ignore' });

    const text = await new Response(proc.stdout).text();

    zoxide = text.split('\n').filter((line) => line !== '');
  } catch {}

  const seen = new Set<string>();

  const found: string[] = [];

  for (const d of [...recent, ...zoxide]) {
    if (!seen.has(d) && existsSync(d)) {
      seen.add(d);
      found.push(d);
    }
  }

  if (found.length === 0) {
    found.push(homedir());
  }

  return found;
}

export function pickMatches(items: readonly string[], filter: string): string[] {
  if (filter === '') {
    return [...items];
  }

  const scored: { item: string; score: number }[] = [];

  for (const item of items) {
    // Basename hits beat full-path hits, so `vers` ranks ~/projects/vers
    // above every path that merely passes through a vers directory.
    const baseScore = findFuzzyScore(basename(item), filter);
    const pathScore = findFuzzyScore(item, filter);
    const score = baseScore === null ? pathScore : baseScore + 100;

    if (score !== null) {
      scored.push({ item, score });
    }
  }

  return scored.toSorted((a, b) => b.score - a.score).map((x) => x.item);
}

export function formatDir(d: string): string {
  const home = homedir();

  return d.startsWith(home) ? `~${d.slice(home.length)}` : d;
}

const SEPARATORS = new Set(['/', '-', '_', '.', ' ']);

/**
 * Scores how well a filter fuzzy-matches a candidate: every filter
 * character must appear in order, consecutive characters and characters
 * starting a word score higher, and a miss is null rather than zero so
 * non-matches are distinguishable from weak matches.
 */
export function findFuzzyScore(candidate: string, filter: string): number | null {
  const hay = candidate.toLowerCase();
  const needle = filter.toLowerCase();
  let score = 0;
  let pos = 0;
  let prevHit = -2;

  for (const ch of needle) {
    const hit = hay.indexOf(ch, pos);

    if (hit === -1) {
      return null;
    }

    score += 1;

    if (hit === prevHit + 1) {
      score += 2;
    }

    const before = hay[hit - 1];

    if (hit === 0 || (before !== undefined && SEPARATORS.has(before))) {
      score += 2;
    }

    prevHit = hit;
    pos = hit + 1;
  }

  return score;
}
