import type { SessionID } from '../shared/session-id';

/**
 * Where a session's runtime auth binding stands:
 *
 * - `provisioning`: an attempt is creating the imp or adding grants.
 * - `ready`: every grant is in place and the session may launch.
 * - `revoked`: atc withdrew the grants; the session never launches again
 *   until an explicit rebind.
 * - `revocation_pending`: the binding is blocked, but impd has not yet
 *   confirmed every grant gone, so access may remain until the owner
 *   resolves it.
 * - `rollback_pending`: a failed attempt left effects atc could not
 *   confirm removed.
 * - `rebind_failed`: a rebind failed; the binding keeps its old revision,
 *   the failed one is kept beside it, and auth stays blocked until an
 *   explicit retry.
 */
export type RuntimeAuthBindingState =
  | 'provisioning'
  | 'ready'
  | 'revoked'
  | 'revocation_pending'
  | 'rollback_pending'
  | 'rebind_failed';

/**
 * A rebind's revision, the binding it moves to, and the attempt making it.
 */
interface RuntimeAuthRebind {
  readonly revision: number;
  readonly bindingHash: string;
  readonly bindingJSON: string;
  readonly attemptID: string;
}

/**
 * One host's runtime auth binding, keyed by the session that owns the imp;
 * its sub-sessions share it. The binding holds secret names and rules,
 * never a credential value.
 */
export interface RuntimeAuthBinding {
  readonly hostKey: SessionID;
  readonly target: string;
  readonly targetIdentity: string;
  readonly impName: string;

  // impd's id for the imp; null until the imp exists.
  readonly impID: string | null;
  readonly revision: number;
  readonly bindingHash: string;
  readonly bindingJSON: string;
  readonly state: RuntimeAuthBindingState;

  // The attempt that last provisioned this revision.
  readonly attemptID: string;

  // Whether that attempt created the imp, which only then may be destroyed
  // in its rollback.
  readonly impCreatedByAttempt: boolean;

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
  readonly impID?: string;
  readonly impCreatedByAttempt?: boolean;
  readonly revision?: number;
  readonly bindingHash?: string;
  readonly bindingJSON?: string;
  readonly attemptID?: string;
  readonly rebind?: RuntimeAuthRebind | null;
  readonly revokedAt?: number;
}

/**
 * Where one secret's grant to a host's imp stands. `uncertain` is a grant a
 * stopped daemon left `granting`, which impd's grant list settles on next
 * use; `revocation_pending` is one atc could not confirm removed.
 */
export type RuntimeAuthGrantPhase =
  | 'granting'
  | 'granted'
  | 'uncertain'
  | 'revoking'
  | 'revoked'
  | 'revocation_pending';

/**
 * One secret's grant to a host's imp: the revision and attempt that added
 * it, and whether impd held it before that attempt, which rules it out of
 * the attempt's rollback.
 */
export interface RuntimeAuthGrant {
  readonly hostKey: SessionID;
  readonly secret: string;
  readonly revision: number;
  readonly attemptID: string;
  readonly preexisting: boolean;
  readonly phase: RuntimeAuthGrantPhase;
  readonly updatedAt: number;
}
