import type {
  AuthSelection,
  CredentialBroker,
  CredentialRouter,
  HostCredentials,
} from '@atc/plugin-api';
import { match } from 'ts-pattern';

export type HarnessAuthRefusal =
  | 'broker_required'
  | 'guest_env_conflict'
  | 'route_required'
  | 'auth_on_stored_token'
  | 'sign_in_unsupported';

// `none`: the launch takes no credential from atc.
export type HarnessAuthDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'refused'; readonly problem: HarnessAuthRefusal }
  | { readonly kind: 'broker'; readonly broker: CredentialBroker }
  | { readonly kind: 'routed'; readonly router: CredentialRouter }
  | { readonly kind: 'stored-token' };

// What a launch on a host does about credentials. Each refusal is the first row of the refusal
// table that matches.
export function decideHarnessAuth(
  selection: AuthSelection | null,
  credentials: HostCredentials,
  conflict: string | null,
  signInFile: string | null,
): HarnessAuthDecision {
  return match(credentials)
    .returnType<HarnessAuthDecision>()
    .with({ kind: 'none' }, () =>
      selection?.brokerRequired === true
        ? { kind: 'refused', problem: 'broker_required' }
        : { kind: 'none' },
    )
    .with({ kind: 'broker' }, (broker) => {
      if (conflict !== null) {
        return { kind: 'refused', problem: 'guest_env_conflict' };
      }

      return selection === null ? { kind: 'none' } : { kind: 'broker', broker: broker.broker };
    })
    .with({ kind: 'routed' }, (routed) => {
      if (conflict !== null) {
        return { kind: 'refused', problem: 'guest_env_conflict' };
      }

      return selection === null
        ? { kind: 'refused', problem: 'route_required' }
        : { kind: 'routed', router: routed.router };
    })
    .with({ kind: 'stored-token' }, () => {
      if (conflict !== null) {
        return { kind: 'refused', problem: 'guest_env_conflict' };
      }

      if (selection !== null) {
        return { kind: 'refused', problem: 'auth_on_stored_token' };
      }

      return signInFile === null
        ? { kind: 'refused', problem: 'sign_in_unsupported' }
        : { kind: 'stored-token' };
    })
    .exhaustive();
}
