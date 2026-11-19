export interface SessionPaths {
  // the bridge socket and the reporters' outbox, in the guest folder
  readonly socket: string;
  readonly outbox: string;
  readonly relayDir: string;
}

// The most characters of a session id in a socket path, which a unix socket's path limit bounds.
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
