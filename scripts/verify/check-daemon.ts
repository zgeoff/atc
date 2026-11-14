import { realpath } from 'node:fs/promises';
import { WringerError } from '@wringer/core';
import type { Endpoints } from '@wringer/core';
import { isInsideFolder } from './is-inside-folder.ts';
import { openDaemonConnection } from './open-daemon-connection.ts';
import { parseRunEndpoints } from './run-endpoints.ts';

// The doctor's daemon check: the socket sits in the run's own temp home, never the live daemon's,
// and the daemon there answers a hello. It compares real paths, so a link in the home to another
// daemon's socket fails it.
export async function checkDaemon(endpoints: Endpoints): Promise<{ socket: string }> {
  const run = parseRunEndpoints(endpoints);

  const root = await realpath(run.root);
  const socket = await realpath(run.socket);

  if (!isInsideFolder(root, socket)) {
    throw new WringerError('check-failed', {
      message: `the daemon socket ${socket} is outside the run's home ${root}`,
    });
  }

  using client = await openDaemonConnection(run.socket);

  await client.procedures.session.list({});

  return { socket: run.socket };
}
