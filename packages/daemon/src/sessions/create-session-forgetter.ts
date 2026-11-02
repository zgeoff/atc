import { DaemonError } from '@atc/protocol/wire';
import type { SessionID, WorkspaceCleanup } from '@atcx/contract';
import type { ForgetRefusals, ForgetResult, KillOutcome } from '../daemon-context';
import type { ConfirmTokens } from './create-confirm-tokens';
import type { ForgetCleanup } from './create-forget-cleanup';
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

  // A headless turn's runner gives no exit to wait on, so a session that ran one when the forget
  // began counts as possibly still running in its folders.
  const collectHeadlessRunning = (forgettable: readonly Session[]): Set<Session> =>
    new Set(
      forgettable.filter((other) => {
        const runtime = findRuntime(other.id);

        return runtime !== undefined && (runtime.headlessRun !== null || runtime.headlessStopped);
      }),
    );

  const removeForgottenFolders = async (
    session: Session,
    forgettable: readonly Session[],
    headlessRunning: ReadonlySet<Session>,
    destroyed: boolean,
  ): Promise<WorkspaceCleanup> => {
    // A message bridge runs beside the daemon and writes in the session's state folder, so its
    // stop must finish even when the session's host is gone.
    const probeHarnessEnded = async (other: Session, hostDestroyed: boolean): Promise<boolean> => {
      const bridgeStopped = await manager.stopMessageBridge(other.id).then(
        () => true,
        () => false,
      );

      if (!bridgeStopped) {
        return false;
      }

      if (hostDestroyed) {
        return true;
      }

      if (headlessRunning.has(other)) {
        return false;
      }

      return manager.probeHarnessEnded(other.id);
    };

    const removeFolders = async (other: Session): Promise<WorkspaceCleanup> => {
      const hostDestroyed =
        destroyed && other.hostKey === session.hostKey && other.target === session.target;

      const harnessEnded = await probeHarnessEnded(other, hostDestroyed);

      return cleanup.removeSessionFolders(other, { hostDestroyed, harnessEnded });
    };

    const workspace = await removeFolders(session);

    for (const other of forgettable) {
      if (other !== session && !manager.sessions.includes(other)) {
        await removeFolders(other);
      }
    }

    return workspace;
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

      const outcome = await manager.kill(id, stopOnly);

      stopEndedHeadlessRuns(set);

      // a kill of a session that already exited forgets it
      if (outcome === 'removed') {
        await removeForgottenFolders(session, forgettable, headlessRunning, false);
      }

      return outcome;
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

      const destroyed = await manager.forget(id);

      stopEndedHeadlessRuns(set);

      const workspace = await removeForgottenFolders(
        session,
        forgettable,
        headlessRunning,
        destroyed,
      );

      return { forgotten: true, destroyed, workspace };
    },
  };
}
