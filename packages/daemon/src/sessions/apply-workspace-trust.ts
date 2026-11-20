import { buildTarArchive } from '@atc/core';
import { AtcError } from '@atcx/contract/light';
import { buildGuestSessionDirectory } from './build-guest-session-directory';
import type { SpawnRequest } from './spawn-request';

export async function applyWorkspaceTrust(
  spawn: Readonly<SpawnRequest>,
  root: string,
): Promise<(() => Promise<void>) | null> {
  const adapter = spawn.adapter;
  const provider = spawn.provider;

  if (!provider.remote) {
    const update = adapter.updateLocalWorkspaceTrust;

    if (update === undefined) {
      throw new AtcError('unsupported', 'this adapter cannot trust a cloned workspace');
    }

    return update.call(adapter, root);
  }

  if (adapter.planGuestWorkspaceTrust === undefined || provider.readGuest === undefined) {
    throw new AtcError('unsupported', 'this adapter cannot trust a cloned workspace');
  }

  const guest = await provider.readGuest(spawn.hostKey);

  const directory = buildGuestSessionDirectory(guest.directory, spawn.id);
  const planned = adapter.planGuestWorkspaceTrust(root, directory);

  if (planned === null) {
    throw new AtcError('unsupported', 'this adapter cannot trust a cloned workspace');
  }

  const files = Object.entries(planned).map(([path, content]) => ({ path, content }));

  await spawn.timer.withStep('trust-transfer', () =>
    provider.transferArchive(buildTarArchive(files), directory, spawn.hostKey),
  );

  return null;
}
