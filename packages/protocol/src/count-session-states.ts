import type { SessionState } from './session-state';

/**
 * How many of the sessions are in each state.
 */
export function countSessionStates(
  list: readonly { readonly state: SessionState }[],
): Record<SessionState, number> {
  const c = { needs_you: 0, running: 0, done: 0, exited: 0 };

  for (const s of list) {
    c[s.state]++;
  }

  return c;
}
