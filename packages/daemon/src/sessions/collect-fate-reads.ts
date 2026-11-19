import type { SessionID } from '@atcx/contract';
import type { Session } from './session';

export interface FateScope {
  readonly hostKey?: SessionID;
  readonly except?: SessionID;
}

export interface FateRead {
  readonly target: string;
  readonly hostKey: SessionID;
  readonly sessions: readonly Session[];
}

export function isSleepingSession(session: Session): boolean {
  return session.pty === null && session.suspended && session.state === 'exited';
}

export function collectFateReads(sessions: readonly Session[], scope: FateScope): FateRead[] {
  const sleeping = sessions.filter(
    (session) =>
      isSleepingSession(session) &&
      session.id !== scope.except &&
      (scope.hostKey === undefined || session.hostKey === scope.hostKey),
  );

  const hosts = Map.groupBy(sleeping, (session) => `${session.target}\0${session.hostKey}`);

  return [...hosts.values()].flatMap((onHost) => {
    const [first] = onHost;

    return first === undefined
      ? []
      : [{ target: first.target, hostKey: first.hostKey, sessions: onHost }];
  });
}
