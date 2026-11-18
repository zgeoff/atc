import type { SessionID } from '@atcx/contract';
import { PROTOCOL_VERSION } from '@atcx/contract/light';
import type { TapClient } from '../daemon-context';

// ends the subscription so the tap process behind it exits instead of idling
export function emitInboxClosed(
  tap: TapClient | null,
  sessionID: SessionID,
  reason: 'replaced' | 'removed',
): void {
  tap?.sendEvent({ version: PROTOCOL_VERSION, ev: 'InboxClosed', sessionID, reason });
}
