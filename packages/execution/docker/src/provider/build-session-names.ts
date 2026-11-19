import type { DockerTarget } from '../config/parse-docker-target';

export interface SessionNames {
  readonly harness: string;
  readonly sidecar: string;

  readonly socket: string;
  readonly outbox: string;
}

// The most characters of a session id in a socket path, which a unix socket's path limit bounds.
const SOCKET_ID_LENGTH = 16;

export function buildSessionNames(target: DockerTarget, session: string): SessionNames {
  const short = session
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, '')
    .slice(0, SOCKET_ID_LENGTH);

  return {
    harness: `${target.namePrefix}${session}`,
    sidecar: `${target.namePrefix}${session}-relay`,
    socket: `${target.guestDir}/relay/${short}.sock`,
    outbox: `${target.guestDir}/relay/${short}.outbox`,
  };
}
