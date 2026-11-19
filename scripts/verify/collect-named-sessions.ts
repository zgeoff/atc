interface ListedSession {
  readonly id: string;
  readonly name: string;
  readonly alive: boolean;
}

export function collectNamedSessions(
  sessions: readonly ListedSession[],
  name: string,
): { id: string; alive: boolean }[] {
  return sessions
    .filter((session) => session.name === name)
    .map((session) => ({ id: session.id, alive: session.alive }));
}
