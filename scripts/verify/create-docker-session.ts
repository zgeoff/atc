import type { Endpoints } from '@wringer/core';
import { parseDockerRunEndpoints } from './docker-run-endpoints.ts';
import { openDaemonConnection } from './open-daemon-connection.ts';

// Spawns a session of the stand-in claude on the run's docker target, in the image user's home.
export async function createDockerSession(
  endpoints: Endpoints,
  name: string,
): Promise<{ id: string; name: string }> {
  const run = parseDockerRunEndpoints(endpoints);

  using client = await openDaemonConnection(run.socket);

  const answer = await client.procedures.session.spawn({
    cwd: '/home/agent',
    name,
    target: 'box',
  });

  return { id: answer.session.id, name: answer.session.name };
}
