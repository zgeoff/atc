import type { AtcError } from '@atcx/contract/light';
import type { Session } from '../sessions/session';

export type AdoptResult =
  | { readonly kind: 'adopted'; readonly session: Session | null }
  | { readonly kind: 'refused'; readonly refusal: AtcError };
