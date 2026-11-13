// A daemon is named by its key in the config's `daemons` map; null is the local daemon.
export type DaemonName = string | null;

// A session as the client keys it: the daemon that holds it and the daemon's own session id, which
// the client never rewrites. Two daemons may hold the same id.
export interface SessionKey {
  readonly daemon: DaemonName;
  readonly id: string;
}

export function isSameSessionKey(left: SessionKey, right: SessionKey): boolean {
  return left.daemon === right.daemon && left.id === right.id;
}

// The key alone, without the rest of a row that carries it.
export function toSessionKey(session: SessionKey): SessionKey {
  return { daemon: session.daemon, id: session.id };
}
