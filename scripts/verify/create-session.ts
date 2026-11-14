import type { Endpoints } from '@wringer/core';
import { openDaemonConnection } from './open-daemon-connection.ts';
import { parseRunEndpoints } from './run-endpoints.ts';

// Spawns a session of the default agent, the stand-in claude, in the run's home.
export async function createSession(
  endpoints: Endpoints,
  name: string,
): Promise<{ id: string; name: string }> {
  const run = parseRunEndpoints(endpoints);

  using client = await openDaemonConnection(run.socket);

  const answer = await client.procedures.session.spawn({ cwd: run.home, name });

  return { id: answer.session.id, name: answer.session.name };
}
