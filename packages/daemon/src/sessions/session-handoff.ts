import type { SessionID } from '@atc/core';
import { isTreeInReach } from '../auth/is-tree-in-reach';
import type { TargetAccess } from '../auth/target-access';
import { hasResumableTranscript } from './has-resumable-transcript';
import { runEjectHandoff } from './run-eject-handoff';
import type { SettleScheduler } from './run-eject-handoff';
import type { SessionRuntime } from './session-runtime';
import type { SessionManager } from './sessions';

interface SessionHandoffDeps {
  readonly mgr: Pick<
    SessionManager,
    | 'sessions'
    | 'findAdapter'
    | 'findProvider'
    | 'requireExecution'
    | 'requireAgentTarget'
    | 'yankHeadless'
    | 'adoptTerminal'
  >;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;

  // How long an eject waits for the ejected terminal's final report.
  readonly ejectSettleMs: number;
  readonly scheduleEjectSettle: SettleScheduler;

  // Starts a headless turn with the prompt given, and returns whether one
  // started.
  readonly startHeadlessTurn: (sessionID: SessionID, prompt: string) => boolean;

  // Starts the wait before the session's terminal takes its clients' size.
  readonly scheduleResize: (sessionID: SessionID) => void;
}

export class SessionHandoff {
  private readonly mgr: SessionHandoffDeps['mgr'];

  private readonly findRuntime: SessionHandoffDeps['findRuntime'];

  private readonly ejectSettleMs: number;

  private readonly scheduleEjectSettle: SettleScheduler;

  private readonly startHeadlessTurn: SessionHandoffDeps['startHeadlessTurn'];

  private readonly scheduleResize: SessionHandoffDeps['scheduleResize'];

  constructor(deps: SessionHandoffDeps) {
    this.mgr = deps.mgr;
    this.findRuntime = deps.findRuntime;
    this.ejectSettleMs = deps.ejectSettleMs;
    this.scheduleEjectSettle = deps.scheduleEjectSettle;
    this.startHeadlessTurn = deps.startHeadlessTurn;
    this.scheduleResize = deps.scheduleResize;
  }

  yankSession(id: SessionID, prompt: string): 'ok' | 'missing' | 'unsupported' | 'no_transcript' {
    const s = this.mgr.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return 'missing';
    }

    const adapter = this.mgr.findAdapter(s.agent);

    if (adapter === null || adapter.headlessRunner === null) {
      return 'unsupported';
    }

    if (!hasResumableTranscript(this.mgr, id)) {
      return 'no_transcript';
    }

    this.mgr.requireExecution(s, 'kill');
    this.mgr.requireExecution(s, 'headless');

    const yanked = this.mgr.yankHeadless(id);

    if (yanked === null) {
      return 'missing';
    }

    const runtime = this.findRuntime(id);

    if (runtime === undefined) {
      return 'missing';
    }

    runEjectHandoff({
      sessionID: id,
      prompt,
      settleMs: this.ejectSettleMs,
      scheduleSettle: this.scheduleEjectSettle,
      runtime,
      startHeadlessTurn: this.startHeadlessTurn,
    });

    return 'ok';
  }

  // Under an access, the adopt answers 'missing' once the session's tree
  // leaves it, however late.
  async adoptSession(
    id: SessionID,
    cols: number,
    rows: number,
    access: TargetAccess | null,
  ): Promise<'ok' | 'missing' | 'no_transcript'> {
    if (!hasResumableTranscript(this.mgr, id)) {
      return 'no_transcript';
    }

    const listed = this.mgr.sessions.find((s) => s.id === id);

    // Refused before the headless run stops, so a refusal leaves it as
    // it was.
    if (listed !== undefined) {
      this.mgr.requireAgentTarget(listed.agent, listed.target);
    }

    this.findRuntime(id)?.stopHeadlessRun();

    const adopted = await this.mgr.adoptTerminal(
      id,
      cols,
      rows,
      () => access === null || isTreeInReach(this.mgr.sessions, id, access),
    );

    if (adopted === null) {
      return 'missing';
    }

    this.scheduleResize(id);

    return 'ok';
  }
}
