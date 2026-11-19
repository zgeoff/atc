import type { ExecutionProvider } from '../execution/execution-provider';
import type { HostCredentials } from './host-credentials';

const NO_CREDENTIALS: HostCredentials = { kind: 'none' };

// What a provider declares, with an absent declaration read as none.
export function getHostCredentials(
  provider: Pick<ExecutionProvider, 'credentials'>,
): HostCredentials {
  return provider.credentials ?? NO_CREDENTIALS;
}
