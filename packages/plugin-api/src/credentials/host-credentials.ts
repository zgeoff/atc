import type { CredentialBroker } from './credential-broker';
import type { CredentialRouter } from './credential-router';

// How a provider's host supplies credentials to the agents that run in it.
export type HostCredentials =
  // atc supplies no credential; an agent signs in on the host by itself
  | { readonly kind: 'none' }

  // the host's broker replaces a placeholder in each request with the real credential
  | {
      readonly kind: 'broker';
      readonly broker: CredentialBroker;

      // whether a launch whose agent's auth selection changed since the host was bound moves
      // the host's binding to the current selection instead of refusing
      readonly rebindChangedAuth: boolean;
    }

  // a service outside the host adds the credential
  | { readonly kind: 'routed'; readonly router: CredentialRouter }

  // a token the user stored once, mounted into every container of the target
  | { readonly kind: 'stored-token' };
