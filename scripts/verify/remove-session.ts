import type { Endpoints } from '@wringer/core';
import { collectNamedSessions } from './collect-named-sessions.ts';
import { openDaemonConnection } from './open-daemon-connection.ts';
import { parseRunEndpoints } from './run-endpoints.ts';

// Kills each session with the name that still runs, then forgets it, so a journey leaves no
// session behind. A name that no session has removes nothing.
export async function removeSession(
  endpoints: Endpoints,
  name: string,
): Promise<{ forgotten: string[] }> {
  const run = parseRunEndpoints(endpoints);

  using client = await openDaemonConnection(run.socket);

  const listed = await client.procedures.session.list({});

  const named = collectNamedSessions(listed.sessions, name);

  for (const session of named) {
    if (session.alive) {
      await client.procedures.session.kill({ session: session.id });
    }

    await client.procedures.session.forget({ session: session.id });
  }

  return { forgotten: named.map((session) => session.id) };
}
