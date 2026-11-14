import type { SessionEvent } from './collect-session-events.ts';

// The first step of a session's life that its events lack, in order: it is added, its state
// changes while it runs, and it exits. Null when the events hold all three in that order.
export function findLifecycleGap(events: readonly SessionEvent[]): string | null {
  const added = events.findIndex((event) => event.ev === 'SessionAdded');

  if (added === -1) {
    return 'a SessionAdded line';
  }

  const changed = events.findIndex(
    (event, index) => index > added && event.ev === 'SessionState' && event.state !== 'exited',
  );

  if (changed === -1) {
    return 'a SessionState line after SessionAdded, with a state other than exited';
  }

  const exited = events.findIndex(
    (event, index) => index > changed && event.ev === 'SessionState' && event.state === 'exited',
  );

  return exited === -1 ? 'a SessionState line with the state exited, after the state change' : null;
}
