import type { AuthProfile, CredentialBroker, CredentialRouter, SpawnPlan } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';
import type { AuthBinding } from './build-auth-binding';

// A readied host's harness plan, and the auth attempt that provisioned the
// host, if one did.
export interface HarnessSetup {
  readonly plan: HarnessPlan;
  readonly attemptID: string | null;
}

// How a harness takes its credential from the target's broker: the broker the
// provider reaches, and the binding the agent's selection resolves to now.
export interface BrokerHarnessAuth {
  readonly kind: 'broker';
  readonly host: CredentialBroker;
  readonly binding: AuthBinding;
}

// How a harness sends its requests to routes that add the credential outside
// its host. The launch records no binding, so the selection's binding only
// gives the placeholders and profile variables.
export interface RoutedHarnessAuth {
  readonly kind: 'routed';
  readonly router: CredentialRouter;
  readonly binding: AuthBinding;
  readonly profiles: readonly AuthProfile[];
}

// How a harness takes its credential from the user's stored token, which the
// host mounts.
interface StoredTokenHarnessAuth {
  readonly kind: 'stored-token';
}

export type HarnessAuth = BrokerHarnessAuth | RoutedHarnessAuth | StoredTokenHarnessAuth;

// A harness's auth as its setup applies it: a spawn's own new host creates
// the binding, and every other launch verifies the one its host holds.
export type HarnessAuthSetup = HarnessAuth & {
  readonly mode: 'create' | 'verify';
  readonly targetIdentity: string;
};

// A harness as its setup plans it: the agent's spawn, and the variables
// the agent's plan starts the harness with, which no variable atc adds
// overrides.
export interface HarnessPlan extends SpawnPlan {
  readonly env: Readonly<Record<string, string>>;

  readonly agentHome?: string;

  // What a launch behind the broker was planned under, which its host's
  // binding must still admit when each request goes out; null without
  // runtime auth.
  readonly admission: {
    readonly revision: number;
    readonly hash: string;
    readonly attemptID: string | null;
  } | null;

  // the revision the host's binding held before this launch verified it, the latest a process
  // the start attaches to can have launched under; null when the launch creates its binding or
  // takes no runtime auth
  readonly heldRevision: number | null;
}

export interface AuthRebound {
  readonly revision: number;
  readonly restartPending: readonly SessionID[];
}
