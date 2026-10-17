import type { SessionID } from '@atc/core';

export interface BridgeBinding {
  readonly sessionID: SessionID;
  readonly target: string;
  readonly targetIdentity: string;
  readonly hostKey: SessionID;

  // every start or attach of the session takes a new epoch
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
