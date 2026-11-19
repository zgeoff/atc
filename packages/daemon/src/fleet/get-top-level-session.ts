import type { Session } from '../sessions/session';

export function getTopLevelSession(session: Session, sessions: readonly Session[]): Session {
  const seen = new Set<Session>([session]);

  let current = session;

  for (;;) {
    const parentID = current.parent;
    const parent = sessions.find((candidate) => candidate.id === parentID);

    if (parent === undefined || seen.has(parent)) {
      return current;
    }

    seen.add(parent);

    current = parent;
  }
}
