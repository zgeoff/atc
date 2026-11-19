import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';

// The kernel's answer wins over the handshake: a process inside a session
// acts as that session whether or not it gives one, and one that gives
// another session is refused.
export function resolveCallerSession(
  peerSession: SessionID | null,
  declared: SessionID | null,
): SessionID | null {
  if (peerSession !== null && declared !== null && declared !== peerSession) {
    throw new DaemonError(
      'unauthorized',
      `daemon.hello gives session '${declared}', but the connecting process runs inside session '${peerSession}'`,
    );
  }

  return peerSession ?? declared;
}
