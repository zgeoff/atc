import type { AuthProfile, CredentialBroker, CredentialRouter, SpawnPlan } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';
import type { AuthBinding } from './build-auth-binding';

export interface HarnessSetup {
  readonly plan: HarnessPlan;
  readonly attemptID: string | null;
}

export interface BrokerHarnessAuth {
  readonly kind: 'broker';
  readonly host: CredentialBroker;
  readonly binding: AuthBinding;
}

// The launch records no binding, so the binding here only supplies the placeholders and
// profile variables.
export interface RoutedHarnessAuth {
  readonly kind: 'routed';
  readonly router: CredentialRouter;
  readonly binding: AuthBinding;
  readonly profiles: readonly AuthProfile[];
}

interface StoredTokenHarnessAuth {
  readonly kind: 'stored-token';
}

export type HarnessAuth = BrokerHarnessAuth | RoutedHarnessAuth | StoredTokenHarnessAuth;

export type HarnessAuthSetup = HarnessAuth & {
  readonly mode: 'create' | 'verify';
  readonly targetIdentity: string;
};

// These variables come from the agent's plan. No variable that atc adds overrides them.
export interface HarnessPlan extends SpawnPlan {
  readonly env: Readonly<Record<string, string>>;

  readonly agentHome?: string;

  // The host's binding must still admit these values when each request goes out. Null when the
  // launch has no runtime auth.
  readonly admission: {
    readonly revision: number;
    readonly hash: string;
    readonly attemptID: string | null;
  } | null;

  // The binding revision the host held before this launch checked it. No attached process can have
  // launched under a later revision. Null when the launch creates its binding or has no runtime auth.
  readonly heldRevision: number | null;
}

export interface AuthRebound {
  readonly revision: number;
  readonly restartPending: readonly SessionID[];
}
