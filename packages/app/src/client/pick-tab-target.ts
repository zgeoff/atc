import type { SessionState } from '@atc/protocol';
import { sortSessionViews } from '@atc/protocol';

interface TabCandidate {
  readonly id: string;
  readonly parent: string | null;
  readonly state: SessionState;
  readonly pinned: boolean;
  readonly lastAttachedAt: number;
  readonly createdAt: number;
  readonly alive: boolean;
  readonly kind: 'pty' | 'headless';
}

export function pickTabTarget<T extends TabCandidate>(
  list: readonly T[],
  findDoneAt: (id: string) => number | undefined,
): T | undefined {
  const needy = sortSessionViews(list).find((s) => s.state === 'needs_you' && s.alive);

  if (needy !== undefined) {
    return needy;
  }

  // a headless session has no terminal to attach, so it never takes the fallback.
  return sortSessionViews(list)
    .filter((s) => s.state === 'done' && s.alive && s.kind === 'pty')
    .toSorted((a, b) => (findDoneAt(b.id) ?? 0) - (findDoneAt(a.id) ?? 0))[0];
}
