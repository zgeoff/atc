import type { ExecutionProvider } from '@atc/plugin-api';
import { getHostCredentials } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';

export function requireNotRouted(provider: Pick<ExecutionProvider, 'credentials'> | null): void {
  if (provider !== null && getHostCredentials(provider).kind === 'routed') {
    throw new DaemonError(
      'unsupported_operation',
      "this host's credentials come from routes, which atc neither revokes nor rebinds",
      { problem: 'routed_auth' },
    );
  }
}
