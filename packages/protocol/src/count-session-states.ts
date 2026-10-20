import type { SessionState } from './session-state';

export function countSessionStates(
  list: readonly { readonly state: SessionState }[],
): Record<SessionState, number> {
  const counts = { needs_you: 0, running: 0, done: 0, exited: 0 };

  for (const session of list) {
    counts[session.state]++;
  }

  return counts;
}
