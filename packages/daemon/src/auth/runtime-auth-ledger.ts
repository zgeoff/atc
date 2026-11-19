import type { StateStore } from '@atc/store';

export type RuntimeAuthStore = Pick<
  StateStore,
  | 'createAuthBinding'
  | 'updateAuthBinding'
  | 'readAuthBinding'
  | 'readAuthBindings'
  | 'upsertAuthGrant'
  | 'readAuthGrants'
  | 'removeAuthBinding'
>;

export interface RuntimeAuthLedger {
  readonly store: RuntimeAuthStore;
  readonly now: () => number;
}
