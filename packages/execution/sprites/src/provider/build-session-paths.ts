export interface SessionPaths {
  readonly socket: string;
  readonly outbox: string;
  readonly relayDir: string;
}

// Unix socket paths have a short length limit, so the session id is cut to 16 characters.
const SOCKET_ID_LENGTH = 16;

export function buildSessionPaths(guestDir: string, session: string): SessionPaths {
  const short = session
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, '')
    .slice(0, SOCKET_ID_LENGTH);

  return {
    relayDir: `${guestDir}/relay`,
    socket: `${guestDir}/relay/${short}.sock`,
    outbox: `${guestDir}/relay/${short}.outbox`,
  };
}
