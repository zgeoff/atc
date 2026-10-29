import type { DaemonEvent } from '@atcx/contract';
import invariant from 'tiny-invariant';
import { match } from 'ts-pattern';
import { findEventSessionID } from './find-event-session-id';

// How the daemon answered a read of one session as the viewer.
export type SessionVerdict =
  | { readonly kind: 'readable' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'failed'; readonly error: unknown };

export interface ReadFailure {
  readonly sessionID: string;
  readonly error: unknown;
}

interface PickedEvents {
  // The events to forward, in order, with a removal in place of the first
  // event of each session the viewer cannot read.
  readonly forward: readonly DaemonEvent[];
  readonly removed: readonly string[];

  // The first read that failed; the batch stops there, since no verdict
  // decides the events after it.
  readonly failure: ReadFailure | null;
}

export function pickScopedEvents(
  batch: readonly DaemonEvent[],
  verdicts: ReadonlyMap<string, SessionVerdict>,
  removedBefore: ReadonlySet<string>,
): PickedEvents {
  const forward: DaemonEvent[] = [];
  const removed: string[] = [];

  for (const event of batch) {
    const sessionID = findEventSessionID(event);

    if (sessionID === null || removedBefore.has(sessionID) || removed.includes(sessionID)) {
      continue;
    }

    const verdict = verdicts.get(sessionID);

    invariant(verdict, `no verdict for session ${sessionID}`);

    const failure = match(verdict)
      .with({ kind: 'readable' }, () => {
        forward.push(event);

        return null;
      })
      .with({ kind: 'unreadable' }, () => {
        removed.push(sessionID);
        forward.push({ ev: 'SessionRemoved', sessionID });

        return null;
      })
      .with({ kind: 'failed' }, (failed) => ({ sessionID, error: failed.error }))
      .exhaustive();

    if (failure !== null) {
      return { forward, removed, failure };
    }
  }

  return { forward, removed, failure: null };
}
