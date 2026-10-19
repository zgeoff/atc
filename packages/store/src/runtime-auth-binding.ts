import type { SessionID } from '@atc/core';

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

// Keyed by the session that owns the host, and shared by its sub-sessions.
// The binding holds secret names and rules, never a credential value.
export interface RuntimeAuthBinding {
  readonly hostKey: SessionID;
  readonly target: string;
  readonly targetIdentity: string;
  readonly hostName: string;

  // The broker's id for the host; null until the host exists.
  readonly hostID: string | null;
  readonly revision: number;
  readonly bindingHash: string;
  readonly bindingJSON: string;
  readonly state: RuntimeAuthBindingState;

  // The attempt that last provisioned this revision.
  readonly attemptID: string;

  // Whether that attempt created the host, which only then may be destroyed
  // in its rollback.
  readonly hostCreatedByAttempt: boolean;

  // The next revision a rebind is adding, or the failed one it left; null
  // when no rebind is in flight or failed.
  readonly rebind: RuntimeAuthRebind | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revokedAt: number | null;
}

// The fields a binding rewrites as it moves between states; `rebind: null`
// clears a settled rebind.
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

  // The broker held the grant before the attempt, which rules it out of the
  // attempt's rollback.
  readonly preexisting: boolean;
  readonly phase: RuntimeAuthGrantPhase;
  readonly updatedAt: number;
}
