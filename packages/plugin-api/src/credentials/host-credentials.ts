import type { CredentialBroker } from './credential-broker';
import type { CredentialRouter } from './credential-router';

export type HostCredentials =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'broker';
      readonly broker: CredentialBroker;

      readonly rebindChangedAuth: boolean;
    }
  | { readonly kind: 'routed'; readonly router: CredentialRouter }
  | { readonly kind: 'stored-token' };
