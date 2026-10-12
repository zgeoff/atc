import type { DaemonID } from '@atc/core/daemon-id';
import type { SessionID } from '@atc/core/session-id';

interface StaleOwnership {
  readonly sessionID: SessionID;
  readonly ownerDaemonID: DaemonID;
  readonly ownerEpoch: number;
  readonly writerDaemonID: DaemonID;
  readonly writerEpoch: number;
}

/**
 * A fleet write refused because it touches a session another daemon owns,
 * or one whose stored ownership epoch has moved past the writer's. The
 * store wrote nothing, and the daemon answers its caller with
 * `stale_epoch`.
 */
export class StaleOwnershipError extends Error {
  readonly sessionID: SessionID;

  readonly ownerDaemonID: DaemonID;

  readonly ownerEpoch: number;

  constructor(stale: StaleOwnership) {
    super(
      `session '${stale.sessionID}' is owned by daemon '${stale.ownerDaemonID}' at epoch ${stale.ownerEpoch}; this daemon writes as '${stale.writerDaemonID}' at epoch ${stale.writerEpoch}`,
    );

    this.sessionID = stale.sessionID;
    this.ownerDaemonID = stale.ownerDaemonID;
    this.ownerEpoch = stale.ownerEpoch;
    this.name = 'StaleOwnershipError';
  }
}
