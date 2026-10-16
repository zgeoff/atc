import type { SessionID } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { TapClient } from '../daemon-context';

/**
 * Tells a tap its subscription is over so the `atc tap` process behind it
 * exits instead of idling on a session it no longer serves.
 */
export function emitInboxClosed(
  tap: TapClient | null,
  sessionID: SessionID,
  reason: 'replaced' | 'removed',
): void {
  tap?.sendEvent({ v: PROTOCOL_V, ev: 'InboxClosed', s: sessionID, reason });
}
