import type { SessionID } from '@atcx/contract';

export type RuntimeAuthBindingState =
  | 'provisioning'
  | 'ready'

  // The session never launches again until an explicit rebind.
  | 'revoked'

  // Blocked, but the broker has not confirmed every grant gone, so access may
  // remain until the owner resolves it.
  | 'revocation_pending'

  // A failed attempt left effects atc could not confirm removed.
  | 'rollback_pending'

  // The binding keeps its old revision with the failed one beside it, and
  // auth stays blocked until an explicit rebind or the next launch on a
  // target that rebinds a changed selection.
  | 'rebind_failed';

interface RuntimeAuthRebind {
  readonly revision: number;
  readonly bindingHash: string;
  readonly bindingJSON: string;
  readonly attemptID: string;
}

export interface RuntimeAuthBinding {
  readonly hostKey: SessionID;
  readonly target: string;
  readonly targetIdentity: string;
  readonly hostName: string;

  readonly hostID: string | null;
  readonly revision: number;
  readonly bindingHash: string;
  readonly bindingJSON: string;
  readonly state: RuntimeAuthBindingState;

  readonly attemptID: string;

  readonly hostCreatedByAttempt: boolean;

  readonly rebind: RuntimeAuthRebind | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revokedAt: number | null;
}

export interface RuntimeAuthBindingUpdate {
  readonly state?: RuntimeAuthBindingState;
  readonly hostID?: string;
  readonly hostCreatedByAttempt?: boolean;
  readonly revision?: number;
  readonly bindingHash?: string;
  readonly bindingJSON?: string;
  readonly attemptID?: string;
  readonly rebind?: RuntimeAuthRebind | null;
  readonly revokedAt?: number;
}

export type RuntimeAuthGrantPhase =
  | 'granting'
  | 'granted'

  // Left granting by a stopped daemon; the broker's grant list settles it on next
  // use.
  | 'uncertain'
  | 'revoking'
  | 'revoked'

  // Atc could not confirm the grant removed.
  | 'revocation_pending';

export interface RuntimeAuthGrant {
  readonly hostKey: SessionID;
  readonly secret: string;
  readonly revision: number;
  readonly attemptID: string;

  readonly preexisting: boolean;
  readonly phase: RuntimeAuthGrantPhase;
  readonly updatedAt: number;
}
