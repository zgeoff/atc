import type { ExecutionProvider } from '../execution/execution-provider';
import type { CredentialBroker } from './credential-broker';

export function findHostBroker(
  provider: Pick<ExecutionProvider, 'credentials'> | null | undefined,
): CredentialBroker | null {
  const credentials = provider?.credentials;

  return credentials?.kind === 'broker' ? credentials.broker : null;
}
