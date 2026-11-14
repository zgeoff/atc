import { WringerError } from '@wringer/core';
import type { Endpoints } from '@wringer/core';
import { isInsideFolder } from './is-inside-folder.ts';
import { openDaemonConnection } from './open-daemon-connection.ts';
import { parseRunEndpoints } from './run-endpoints.ts';

// The doctor's daemon check: the socket sits in the run's own temp home, never the live daemon's,
// and the daemon there answers a hello.
export async function checkDaemon(endpoints: Endpoints): Promise<{ socket: string }> {
  const run = parseRunEndpoints(endpoints);

  if (!isInsideFolder(run.root, run.socket)) {
    throw new WringerError('check-failed', {
      message: `the daemon socket ${run.socket} is outside the run's home ${run.root}`,
    });
  }

  using client = await openDaemonConnection(run.socket);

  await client.procedures.session.list({});

  return { socket: run.socket };
}
