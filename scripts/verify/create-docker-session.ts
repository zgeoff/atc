import type { Endpoints } from '@wringer/core';
import { parseDockerRunEndpoints } from './docker-run-endpoints.ts';
import { openDaemonConnection } from './open-daemon-connection.ts';
import { waitForDockerHarness } from './wait-for-docker-harness.ts';

// The daemon answers the spawn before the provider starts the harness container, and the
// journey's next line reads that container.
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

  await waitForDockerHarness(run.prefix, answer.session.id);

  return { id: answer.session.id, name: answer.session.name };
}
