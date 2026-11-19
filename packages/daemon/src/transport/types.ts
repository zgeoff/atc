import type { SessionID } from '@atcx/contract';

export interface BridgeGrant {
  readonly holder: SessionID;
  readonly isCurrent: () => boolean;
}
