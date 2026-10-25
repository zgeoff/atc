import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import type { ForgetRefusals, ForgetResult, KillOutcome } from '../daemon-context';
import type { ConfirmTokens } from './create-confirm-tokens';
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
  >;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;
  readonly tokens: Pick<ConfirmTokens, 'mintToken' | 'claimToken'>;
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

      const outcome = await manager.kill(id, stopOnly);

      stopEndedHeadlessRuns(set);

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

      const destroyed = await manager.forget(id);

      stopEndedHeadlessRuns(set);

      return { forgotten: true, destroyed };
    },
  };
}
