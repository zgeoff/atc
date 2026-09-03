import type { SessionState } from '../daemon/sessions';
import { sortSessionViews } from '../daemon/sessions';

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

/**
 * The Tab jump target: the most urgent alive needs-you session, else the
 * alive terminal session whose turn finished most recently. Headless
 * sessions never qualify for the fallback — they have no terminal to
 * attach — and sessions with no recorded finish time rank last.
 */
export function pickTabTarget<T extends TabCandidate>(
  list: readonly T[],
  findDoneAt: (id: string) => number | undefined,
): T | undefined {
  const needy = sortSessionViews(list).find((s) => s.state === 'needs_you' && s.alive);

  if (needy !== undefined) {
    return needy;
  }

  return sortSessionViews(list)
    .filter((s) => s.state === 'done' && s.alive && s.kind === 'pty')
    .toSorted((a, b) => (findDoneAt(b.id) ?? 0) - (findDoneAt(a.id) ?? 0))[0];
}
