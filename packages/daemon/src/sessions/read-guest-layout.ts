import type { ExecutionProvider, GuestLayout } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';

export async function readGuestLayout(
  provider: Pick<ExecutionProvider, 'kind' | 'readGuest'>,
): Promise<GuestLayout> {
  if (provider.readGuest === undefined) {
    throw new DaemonError(
      'unsupported_operation',
      `the ${provider.kind} provider declares no folder for atc's files on its host`,
      { provider: provider.kind, problem: 'no_guest_layout' },
    );
  }

  return await provider.readGuest();
}
