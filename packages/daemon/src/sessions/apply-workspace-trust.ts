import { buildTarArchive } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import type { SpawnRequest } from './spawn-request';

// Trusts a cloned workspace: in the user's own agent config on the local
// target, returning how to take the trust back, or in the session's guest
// folder on an imp, which takes nothing back.
export async function applyWorkspaceTrust(
  spawn: Readonly<SpawnRequest>,
  root: string,
): Promise<(() => Promise<void>) | null> {
  const adapter = spawn.adapter;
  const provider = spawn.provider;

  if (!provider.remote) {
    const update = adapter.updateLocalWorkspaceTrust;

    if (update === undefined) {
      throw new DaemonError('unsupported', 'this adapter cannot trust a cloned workspace');
    }

    return update.call(adapter, root);
  }

  const planned = adapter.planGuestWorkspaceTrust?.(root);

  if (planned === undefined || planned === null || provider.guest === undefined) {
    throw new DaemonError('unsupported', 'this adapter cannot trust a cloned workspace');
  }

  const files = Object.entries(planned).map(([path, content]) => ({ path, content }));
  const dir = `${provider.guest.directory}/sessions/${spawn.id}`;

  await spawn.timer.withStep('trust-transfer', () =>
    provider.transferArchive(buildTarArchive(files), dir, spawn.hostKey),
  );

  return null;
}
