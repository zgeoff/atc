import type { SessionID } from '../shared/session-id';

/**
 * What one session bridge was opened for: the session, the target and
 * target identity it ran on, the host it runs on, and the epoch of the
 * harness start or attach that opened it. Every start or attach of the
 * session takes a new epoch.
 */
export interface BridgeBinding {
  readonly sessionID: SessionID;
  readonly target: string;
  readonly targetIdentity: string;
  readonly hostKey: SessionID;
  readonly epoch: number;
}

// The fields of a live session a binding is checked against.
interface BoundSession {
  readonly id: SessionID;
  readonly target: string;
  readonly targetIdentity: string;
  readonly hostKey: SessionID;
  readonly bridgeEpoch: number;
}

/**
 * Whether a bridge's binding still matches the live session it serves. A
 * session that is gone, moved to another target or identity or host, or
 * started or attached again since the bridge opened fails the check.
 */
export function isBindingCurrent(
  binding: Readonly<BridgeBinding>,
  session: Readonly<BoundSession> | undefined,
): boolean {
  return (
    session !== undefined &&
    session.id === binding.sessionID &&
    session.target === binding.target &&
    session.targetIdentity === binding.targetIdentity &&
    session.hostKey === binding.hostKey &&
    session.bridgeEpoch === binding.epoch
  );
}
