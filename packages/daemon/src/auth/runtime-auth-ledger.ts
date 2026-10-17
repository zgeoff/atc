import type { StateStore } from '@atc/store';

export type RuntimeAuthStore = Pick<
  StateStore,
  | 'createAuthBinding'
  | 'updateAuthBinding'
  | 'findAuthBinding'
  | 'collectAuthBindings'
  | 'upsertAuthGrant'
  | 'collectAuthGrants'
  | 'removeAuthBinding'
>;

// The store a binding's rows live in, and the clock each write stamps.
export interface RuntimeAuthLedger {
  readonly store: RuntimeAuthStore;
  readonly now: () => number;
}
