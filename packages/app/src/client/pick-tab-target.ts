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
  const needy = sortSessionViews(list).find(
    (session) => session.state === 'needs_you' && session.alive,
  );

  if (needy !== undefined) {
    return needy;
  }

  // a headless session has no terminal to attach, so it never takes the fallback.
  return sortSessionViews(list)
    .filter((session) => session.state === 'done' && session.alive && session.kind === 'pty')
    .toSorted((left, right) => (findDoneAt(right.id) ?? 0) - (findDoneAt(left.id) ?? 0))[0];
}
