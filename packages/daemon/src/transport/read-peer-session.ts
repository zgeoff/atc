import type { SessionID } from '@atcx/contract';
import { readParentPID } from './read-parent-pid';

// More steps than any real process tree is deep, so a cycle a reused pid
// could form never loops forever.
const MAX_DEPTH = 1024;

// a process that leaves the parent chain, such as one that forks twice and lets its parent
// exit, is found in no session
export function readPeerSession(
  pid: number,
  harnesses: ReadonlyMap<number, SessionID>,
  readParent: (pid: number) => number | null = readParentPID,
): SessionID | null {
  let current: number | null = pid;

  for (let depth = 0; current !== null && current > 1 && depth < MAX_DEPTH; depth++) {
    const session = harnesses.get(current);

    if (session !== undefined) {
      return session;
    }

    current = readParent(current);
  }

  return null;
}
