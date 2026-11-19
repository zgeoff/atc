import { waitFor } from '@atc/core/test-utils/wait-for';
import { WringerError } from '@wringer/core';
import type { Endpoints } from '@wringer/core';
import { collectNamedSessions } from './collect-named-sessions.ts';
import { parseDockerRunEndpoints } from './docker-run-endpoints.ts';
import { openDaemonConnection } from './open-daemon-connection.ts';

// Kills the one live session with the name, which pauses its containers, then revives it and waits
// until the daemon lists it alive again.
export async function wakeDockerSession(
  endpoints: Endpoints,
  name: string,
): Promise<{ id: string }> {
  const run = parseDockerRunEndpoints(endpoints);

  using client = await openDaemonConnection(run.socket);

  const listed = await client.procedures.session.list({});

  const session = collectNamedSessions(listed.sessions, name).find((found) => found.alive);

  if (session === undefined) {
    throw new WringerError('check-failed', { message: `no live session named ${name}` });
  }

  await client.procedures.session.kill({ session: session.id });
  await client.procedures.session.adopt({ session: session.id, cols: 80, rows: 24 });

  await waitFor(async () => {
    const after = await client.procedures.session.list({});

    const [found] = collectNamedSessions(after.sessions, name);

    if (found?.alive !== true) {
      throw new Error(`session ${name} is not alive again`);
    }
  });

  return { id: session.id };
}
