import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { resolveHomeDir } from '@atc/config/host';
import { formatHomePath } from '@atc/core';
import { collectRootDirs } from '@atc/source-dirs';

export interface DirSources {
  readonly cwd: string;
  readonly recent: readonly string[];
  readonly roots: readonly string[];
  readonly zoxide: readonly string[];
  readonly home?: string;
}

export function collectDirs(sources: DirSources): string[] {
  const seen = new Set<string>();

  const found: string[] = [];

  for (const d of [
    sources.cwd,
    ...sources.recent,
    ...collectRootDirs(sources.roots),
    ...sources.zoxide,
  ]) {
    if (!seen.has(d) && existsSync(d)) {
      seen.add(d);
      found.push(d);
    }
  }

  if (found.length === 0) {
    found.push(sources.home ?? resolveHomeDir());
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
  return formatHomePath(d, resolveHomeDir());
}

export function formatDirName(d: string): string {
  return basename(d);
}

const SEPARATORS = new Set(['/', '-', '_', '.', ' ']);

export function findFuzzyScore(candidate: string, filter: string): number | null {
  const hay = candidate.toLowerCase();
  const needle = filter.toLowerCase();
  let score = 0;
  let pos = 0;
  let prevHit = -2;

  for (const ch of needle) {
    const hit = hay.indexOf(ch, pos);

    // a miss is null, not zero, so it never ranks as a weak match.
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
