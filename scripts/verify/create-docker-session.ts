import { waitFor } from '@atc/core/test-utils/wait-for';
import type { Endpoints } from '@wringer/core';
import { collectNamedSessions } from './collect-named-sessions.ts';
import { parseDockerRunEndpoints } from './docker-run-endpoints.ts';
import { openDaemonConnection } from './open-daemon-connection.ts';

// The daemon answers the spawn before the harness container starts, so the action waits until the
// session is alive: the journey's next line reads that container.
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

  await waitFor(async () => {
    const listed = await client.procedures.session.list({});

    const [found] = collectNamedSessions(listed.sessions, name);

    if (found?.alive !== true) {
      throw new Error(`session ${name} is not alive yet`);
    }
  });

  return { id: answer.session.id, name: answer.session.name };
}
