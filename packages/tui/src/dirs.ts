import { basename } from 'node:path';
import { formatHomePath } from '@atc/core';
import { resolveHomeDir } from '@atcx/contract/light';

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

  return scored.toSorted((left, right) => right.score - left.score).map((x) => x.item);
}

export function formatDir(directory: string): string {
  return formatHomePath(directory, resolveHomeDir());
}

export function formatDirName(directory: string): string {
  return basename(directory);
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
