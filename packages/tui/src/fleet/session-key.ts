export type DaemonName = string | null;

// Two daemons may hold the same id.
export interface SessionKey {
  readonly daemon: DaemonName;
  readonly id: string;
}

export function isSameSessionKey(left: SessionKey, right: SessionKey): boolean {
  return left.daemon === right.daemon && left.id === right.id;
}

export function toSessionKey(session: SessionKey): SessionKey {
  return { daemon: session.daemon, id: session.id };
}
