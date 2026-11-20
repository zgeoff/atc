import type { SessionViewState } from './session-state';

export function countSessionStates(
  list: readonly { readonly state: SessionViewState }[],
): Record<SessionViewState, number> {
  const counts = { needs_you: 0, running: 0, done: 0, exited: 0, unknown: 0 };

  for (const session of list) {
    counts[session.state]++;
  }

  return counts;
}
