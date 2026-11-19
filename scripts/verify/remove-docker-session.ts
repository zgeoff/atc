import type { Endpoints } from '@wringer/core';
import { collectNamedSessions } from './collect-named-sessions.ts';
import { parseDockerRunEndpoints } from './docker-run-endpoints.ts';
import { openDaemonConnection } from './open-daemon-connection.ts';

// Kills each session with the name that still runs, then forgets it. A forget on a docker target
// destroys the host, so the daemon offers a confirm token first and the call sends it back.
export async function removeDockerSession(
  endpoints: Endpoints,
  name: string,
): Promise<{ forgotten: string[] }> {
  const run = parseDockerRunEndpoints(endpoints);

  using client = await openDaemonConnection(run.socket);

  const listed = await client.procedures.session.list({});

  const named = collectNamedSessions(listed.sessions, name);

  for (const session of named) {
    if (session.alive) {
      await client.procedures.session.kill({ session: session.id });
    }

    const offered = await client.procedures.session.forget({ session: session.id });

    if ('confirmToken' in offered) {
      await client.procedures.session.forget({
        session: session.id,
        confirmToken: offered.confirmToken,
      });
    }
  }

  return { forgotten: named.map((session) => session.id) };
}
