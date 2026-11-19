import type { DaemonError } from '@atc/protocol/wire';
import type { Session } from '../sessions/session';

// How one try at a session's terminal ended: the session it adopted, or
// null when there was nothing to adopt, or the refusal its target gave.
export type AdoptResult =
  | { readonly kind: 'adopted'; readonly session: Session | null }
  | { readonly kind: 'refused'; readonly refusal: DaemonError };
