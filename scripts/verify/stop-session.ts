import { WringerError } from '@wringer/core';
import type { Endpoints } from '@wringer/core';
import { collectNamedSessions } from './collect-named-sessions.ts';
import { openDaemonConnection } from './open-daemon-connection.ts';
import { parseRunEndpoints } from './run-endpoints.ts';

// Kills the one live session with the name. The daemon keeps it listed, as exited.
export async function stopSession(endpoints: Endpoints, name: string): Promise<{ id: string }> {
  const run = parseRunEndpoints(endpoints);

  using client = await openDaemonConnection(run.socket);

  const listed = await client.procedures.session.list({});

  const live = collectNamedSessions(listed.sessions, name).filter((session) => session.alive);
  const [session] = live;

  if (session === undefined || live.length > 1) {
    throw new WringerError('check-failed', {
      message: `expected one live session named ${name}, found ${String(live.length)}`,
    });
  }

  await client.procedures.session.kill({ session: session.id });

  return { id: session.id };
}
