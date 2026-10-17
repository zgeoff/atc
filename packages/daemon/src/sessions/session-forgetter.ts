import type { SessionID } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import type { ForgetRefusals, ForgetResult, KillOutcome } from '../daemon-context';
import type { ConfirmTokens } from './confirm-tokens';
import type { Session } from './session';
import type { SessionRuntime } from './session-runtime';
import type { SessionManager } from './sessions';

interface SessionForgetterDeps {
  readonly mgr: Pick<
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

export class SessionForgetter {
  private readonly mgr: SessionForgetterDeps['mgr'];

  private readonly findRuntime: SessionForgetterDeps['findRuntime'];

  private readonly tokens: SessionForgetterDeps['tokens'];

  constructor(deps: SessionForgetterDeps) {
    this.mgr = deps.mgr;
    this.findRuntime = deps.findRuntime;
    this.tokens = deps.tokens;
  }

  // Every live session of the tree must take the kill on its target before
  // any of them is killed.
  async killSession(id: SessionID, stopOnly: boolean): Promise<KillOutcome> {
    const s = this.mgr.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return 'missing';
    }

    for (const live of [s, ...this.mgr.collectChildren(id)]) {
      if (live.pty !== null) {
        this.mgr.requireExecution(live, this.mgr.pickKillCapability(live));
      }
    }

    const set = [s, ...this.mgr.collectChildren(id)];

    const outcome = await this.mgr.kill(id, stopOnly);

    this.stopEndedHeadlessRuns(set);

    return outcome;
  }

  // the refusals read the session in the same step that starts the forget,
  // so a pin or revive that lands first is seen
  async forgetSession(
    id: SessionID,
    confirmToken: string | undefined,
    refuse: ForgetRefusals,
    caller: SessionID | null,
  ): Promise<ForgetResult | 'missing'> {
    const s = this.mgr.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return 'missing';
    }

    const owned = caller !== null && caller !== id && this.mgr.isCallerTree(caller, id);
    const inheritsPin = !owned && this.mgr.sessions.some((x) => x.id === s.parent && x.pinned);

    if (refuse.pinned && (s.pinned || inheritsPin)) {
      throw new DaemonError(
        'session_pinned',
        `session ${id} is pinned, or is a sub-session of a pinned session and the caller is not its parent; unpin it before forgetting it`,
        { session: id },
      );
    }

    if (refuse.live && (s.pty !== null || (s.kind === 'headless' && s.state !== 'exited'))) {
      throw new DaemonError('session_live', `session ${id} is live; stop it before forgetting it`, {
        session: id,
      });
    }

    if (this.mgr.findProvider(s)?.capabilities.destroy === true) {
      this.mgr.requireExecution(s, 'destroy');

      if (confirmToken === undefined) {
        return this.tokens.mintToken(id);
      }

      this.tokens.claimToken(id, confirmToken);
    }

    const set = [s, ...this.mgr.collectChildren(id)];

    const destroyed = await this.mgr.forget(id);

    this.stopEndedHeadlessRuns(set);

    return { forgotten: true, destroyed };
  }

  // runs once the manager has acted: a removed session already lost its run
  // with its runtime, and a promoted sub-session, or any session of a failed
  // kill or forget, keeps working
  private stopEndedHeadlessRuns(set: readonly Session[]): void {
    for (const s of set) {
      if (s.state === 'exited') {
        this.findRuntime(s.id)?.stopHeadlessRun();
      }
    }
  }
}
