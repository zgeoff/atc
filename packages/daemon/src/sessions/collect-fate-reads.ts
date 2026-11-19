import type { SessionID } from '@atcx/contract';
import type { Session } from './session';

// The hosts a read of harness fates covers: every host, or one, leaving one session out.
export interface FateScope {
  readonly hostKey?: SessionID;
  readonly except?: SessionID;
}

// What one host's provider is asked: the host, the target it belongs to, and the sleeping
// sessions on it.
export interface FateRead {
  readonly target: string;
  readonly hostKey: SessionID;
  readonly sessions: readonly Session[];
}

// A session whose harness the daemon last left inside a sleeping host, with no terminal.
export function isSleepingSession(session: Session): boolean {
  return session.pty === null && session.suspended && session.state === 'exited';
}

// One read for each host that holds sleeping sessions in the scope.
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
