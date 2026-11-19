import type { ExecutionProvider } from '../execution/execution-provider';
import type { CredentialBroker } from './credential-broker';

// The broker of a provider whose host has one, or null for any other kind of credentials.
export function findHostBroker(
  provider: Pick<ExecutionProvider, 'credentials'> | null | undefined,
): CredentialBroker | null {
  const credentials = provider?.credentials;

  return credentials?.kind === 'broker' ? credentials.broker : null;
}
