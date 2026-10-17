import type { SessionID } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { TapClient } from '../daemon-context';

// ends the subscription so the tap process behind it exits instead of idling
export function emitInboxClosed(
  tap: TapClient | null,
  sessionID: SessionID,
  reason: 'replaced' | 'removed',
): void {
  tap?.sendEvent({ v: PROTOCOL_V, ev: 'InboxClosed', s: sessionID, reason });
}
