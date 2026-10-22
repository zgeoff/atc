import type { ExecutionProvider, GuestLayout } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';

export function readGuestLayout(
  provider: Pick<ExecutionProvider, 'kind' | 'readGuest'>,
  host: string,
): Promise<GuestLayout> {
  if (provider.readGuest === undefined) {
    return Promise.reject(
      new DaemonError(
        'unsupported_operation',
        `the ${provider.kind} provider declares no folder for atc's files on its host`,
        { provider: provider.kind, problem: 'no_guest_layout' },
      ),
    );
  }

  return provider.readGuest(host);
}
