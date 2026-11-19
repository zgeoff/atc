import type { SessionViewState } from '@atc/protocol';
import { sortSessionViews } from '@atc/protocol';
import { collectPinnedFirst } from '../fleet/collect-pinned-first';
import type { DaemonName, SessionKey } from '../fleet/session-key';

interface TabCandidate {
  readonly daemon: DaemonName;
  readonly id: string;
  readonly parent: string | null;
  readonly state: SessionViewState;
  readonly pinned: boolean;
  readonly lastAttachedAt: number;
  readonly createdAt: number;
  readonly alive: boolean;
  readonly kind: 'pty' | 'headless';
}

// Each daemon's rows sort on their own, so a sub-session never nests under another daemon's row of the same id.
export function pickTabTarget<T extends TabCandidate>(
  list: readonly T[],
  findDoneAt: (key: SessionKey) => number | undefined,
): T | undefined {
  const daemons = [...new Set(list.map((session) => session.daemon))];

  const sorted = collectPinnedFirst(
    daemons.map((daemon) => sortSessionViews(list.filter((session) => session.daemon === daemon))),
  );

  const needy = sorted.find((session) => session.state === 'needs_you' && session.alive);

  if (needy !== undefined) {
    return needy;
  }

  return sorted
    .filter((session) => session.state === 'done' && session.alive && session.kind === 'pty')
    .toSorted((left, right) => (findDoneAt(right) ?? 0) - (findDoneAt(left) ?? 0))[0];
}
