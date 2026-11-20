import type { SessionID } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';

export function resolveCallerSession(
  peerSession: SessionID | null,
  declared: SessionID | null,
): SessionID | null {
  if (peerSession !== null && declared !== null && declared !== peerSession) {
    throw new AtcError(
      'unauthorized',
      `daemon.hello gives session '${declared}', but the connecting process runs inside session '${peerSession}'`,
    );
  }

  return peerSession ?? declared;
}
