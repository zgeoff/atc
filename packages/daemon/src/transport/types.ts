import type { SessionID } from '@atcx/contract';

// A connection through a session's bridge socket.
export interface BridgeGrant {
  readonly holder: SessionID;
  readonly isCurrent: () => boolean;
}
