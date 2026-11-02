import { DaemonError } from '@atc/protocol/wire';
import type { SessionID, WorkspaceCleanup } from '@atcx/contract';
import type { ForgetRefusals, ForgetResult, KillOutcome } from '../daemon-context';
import type { ConfirmTokens } from './create-confirm-tokens';
import type { ForgetCleanup } from './create-forget-cleanup';
import type { SessionHold } from './create-host-dir-claims';
import type { SessionManager } from './create-session-manager';
import type { SessionRuntime } from './create-session-runtime';
import type { Session } from './session';

interface SessionForgetterDeps {
  readonly manager: Pick<
    SessionManager,
    | 'sessions'
    | 'collectChildren'
    | 'requireExecution'
    | 'pickKillCapability'
    | 'kill'
    | 'isCallerTree'
    | 'findProvider'
    | 'forget'
    | 'probeHarnessEnded'
    | 'stopMessageBridge'
    | 'holdSessions'
  >;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;
  readonly tokens: Pick<ConfirmTokens, 'mintToken' | 'claimToken'>;
  readonly cleanup: ForgetCleanup;
}

export interface SessionForgetter {
  // Every live session of the tree must take the kill on its target before
  // any of them is killed.
  readonly killSession: (id: SessionID, stopOnly: boolean) => Promise<KillOutcome>;

  // the refusals read the session in the same step that starts the forget,
  // so a pin or revive that lands first is seen
  readonly forgetSession: (
    id: SessionID,
    confirmToken: string | undefined,
    refuse: ForgetRefusals,
    caller: SessionID | null,
  ) => Promise<ForgetResult | 'missing'>;
}

interface ForgottenFolders {
  readonly session: Session;

  // Every session the forget may take off the list, read before it went.
  readonly forgettable: readonly Session[];
  readonly headlessRunning: ReadonlySet<Session>;
  readonly destroyed: boolean;

  // The kill's or forget's own hold, which it releases session by session.
  readonly hold: SessionHold;
}

export function createSessionForgetter(deps: SessionForgetterDeps): SessionForgetter {
  const manager = deps.manager;
  const findRuntime = deps.findRuntime;
  const tokens = deps.tokens;
  const cleanup = deps.cleanup;

  // runs once the manager has acted: a removed session already lost its run
  // with its runtime, and a promoted sub-session, or any session of a failed
  // kill or forget, keeps working
  const stopEndedHeadlessRuns = (set: readonly Session[]): void => {
    for (const session of set) {
      if (session.state === 'exited') {
        findRuntime(session.id)?.stopHeadlessRun();
      }
    }
  };

  // A forget may take off the list the session, its sub-sessions, and every session on its host,
  // which a destroy takes with it; read before the forget, which changes all three.
  const collectForgettable = (session: Session): Session[] => [
    ...new Set([
      session,
      ...manager.collectChildren(session.id),
      ...manager.sessions.filter(
        (other) => other.hostKey === session.hostKey && other.target === session.target,
      ),
    ]),
  ];

  // A headless turn's runner gives no exit to wait on, so a session that ever started one counts
  // as possibly still running in its folders.
  const collectHeadlessRunning = (forgettable: readonly Session[]): Set<Session> =>
    new Set(forgettable.filter((other) => findRuntime(other.id)?.headlessStarted === true));

  const removeForgottenFolders = async (removal: ForgottenFolders): Promise<WorkspaceCleanup> => {
    const session = removal.session;
    const forgettable = removal.forgettable;
    const hold = removal.hold;

    // A message bridge runs beside the daemon and writes in the session's state folder, so its
    // stop must finish even when the session's host is gone.
    const probeHarnessEnded = async (other: Session, hostDestroyed: boolean): Promise<boolean> => {
      const bridgeStopped = await manager.stopMessageBridge(other.id).then(
        () => true,
        () => false,
      );

      const harnessEnded = await manager.probeHarnessEnded(other.id);

      return isSessionEnded({
        bridgeStopped,
        hostDestroyed,
        harnessEnded,
        headless: removal.headlessRunning.has(other),
      });
    };

    const removeFolders = async (other: Session): Promise<WorkspaceCleanup> => {
      const hostDestroyed =
        removal.destroyed && other.hostKey === session.hostKey && other.target === session.target;

      const harnessEnded = await probeHarnessEnded(other, hostDestroyed);

      return cleanup.removeSessionFolders(other, { hostDestroyed, harnessEnded, hold });
    };

    const removed = forgettable.filter((other) => !manager.sessions.includes(other));

    hold.release(forgettable.filter((other) => manager.sessions.includes(other)));

    // the sessions taken with it go first, so a sub-session that ran in the session's workspace
    // and ended no longer holds it
    for (const other of removed) {
      if (other !== session) {
        await removeFolders(other);
      }
    }

    return removeFolders(session);
  };

  // A kill or forget that throws leaves its sessions listed, so they need no hold. Each one
  // releases only through its own hold, so it never ends another's.
  const withHeldSessions = async <T>(
    forgettable: readonly Session[],
    run: (hold: SessionHold) => Promise<T>,
  ): Promise<T> => {
    const hold = manager.holdSessions(forgettable);

    try {
      return await run(hold);
    } catch (error) {
      hold.release(forgettable.filter((other) => manager.sessions.includes(other)));
      throw error;
    }
  };

  return {
    killSession: async (id, stopOnly) => {
      const session = manager.sessions.find((x) => x.id === id);

      if (session === undefined) {
        return 'missing';
      }

      for (const live of [session, ...manager.collectChildren(id)]) {
        if (live.pty !== null) {
          manager.requireExecution(live, manager.pickKillCapability(live));
        }
      }

      const set = [session, ...manager.collectChildren(id)];
      const forgettable = collectForgettable(session);
      const headlessRunning = collectHeadlessRunning(forgettable);

      const killed = await withHeldSessions(forgettable, async (hold) => {
        const outcome = await manager.kill(id, stopOnly);

        stopEndedHeadlessRuns(set);

        // a kill of a session that already exited forgets it
        if (outcome === 'removed') {
          await removeForgottenFolders({
            session,
            forgettable,
            headlessRunning,
            destroyed: false,
            hold,
          });
        } else {
          hold.release(forgettable);
        }

        return outcome;
      });

      return killed;
    },

    forgetSession: async (id, confirmToken, refuse, caller) => {
      const session = manager.sessions.find((x) => x.id === id);

      if (session === undefined) {
        return 'missing';
      }

      const owned = caller !== null && caller !== id && manager.isCallerTree(caller, id);

      const inheritsPin =
        !owned && manager.sessions.some((x) => x.id === session.parent && x.pinned);

      if (refuse.pinned && (session.pinned || inheritsPin)) {
        throw new DaemonError(
          'session_pinned',
          `session ${id} is pinned, or is a sub-session of a pinned session and the caller is not its parent; unpin it before forgetting it`,
          { session: id },
        );
      }

      if (
        refuse.live &&
        (session.pty !== null || (session.kind === 'headless' && session.state !== 'exited'))
      ) {
        throw new DaemonError(
          'session_live',
          `session ${id} is live; stop it before forgetting it`,
          {
            session: id,
          },
        );
      }

      if (manager.findProvider(session)?.capabilities.destroy === true) {
        manager.requireExecution(session, 'destroy');

        if (confirmToken === undefined) {
          return tokens.mintToken(id);
        }

        tokens.claimToken(id, confirmToken);
      }

      const set = [session, ...manager.collectChildren(id)];
      const forgettable = collectForgettable(session);
      const headlessRunning = collectHeadlessRunning(forgettable);

      const forgotten = await withHeldSessions<ForgetResult>(forgettable, async (hold) => {
        const destroyed = await manager.forget(id);

        stopEndedHeadlessRuns(set);

        const workspace = await removeForgottenFolders({
          session,
          forgettable,
          headlessRunning,
          destroyed,
          hold,
        });

        return { forgotten: true, destroyed, workspace };
      });

      return forgotten;
    },
  };
}

interface SessionEndFacts {
  readonly bridgeStopped: boolean;

  // Whether the forget destroyed the session's host, which ends every process inside it.
  readonly hostDestroyed: boolean;
  readonly harnessEnded: boolean;

  // Whether the session ran a headless turn, whose runner reports no exit.
  readonly headless: boolean;
}

// Whether nothing of a forgotten session can still write in its folders.
function isSessionEnded(facts: SessionEndFacts): boolean {
  return facts.bridgeStopped && (facts.hostDestroyed || (facts.harnessEnded && !facts.headless));
}
