import type { SessionID } from '@atc/core';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import { isTreeInReach } from '../auth/is-tree-in-reach';
import type { SessionRuntime } from './create-session-runtime';
import { hasResumableTranscript } from './has-resumable-transcript';
import { requireSessionPluginDirs } from './require-session-plugin-dirs';
import { runEjectHandoff } from './run-eject-handoff';
import type { SettleScheduler } from './run-eject-handoff';
import type { SessionManager } from './sessions';

interface SessionHandoffDeps {
  readonly manager: Pick<
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
  private readonly manager: SessionHandoffDeps['manager'];

  private readonly findRuntime: SessionHandoffDeps['findRuntime'];

  private readonly ejectSettleMs: number;

  private readonly scheduleEjectSettle: SettleScheduler;

  private readonly startHeadlessTurn: SessionHandoffDeps['startHeadlessTurn'];

  private readonly scheduleResize: SessionHandoffDeps['scheduleResize'];

  constructor(deps: SessionHandoffDeps) {
    this.manager = deps.manager;
    this.findRuntime = deps.findRuntime;
    this.ejectSettleMs = deps.ejectSettleMs;
    this.scheduleEjectSettle = deps.scheduleEjectSettle;
    this.startHeadlessTurn = deps.startHeadlessTurn;
    this.scheduleResize = deps.scheduleResize;
  }

  yankSession(id: SessionID, prompt: string): 'ok' | 'missing' | 'unsupported' | 'no_transcript' {
    const session = this.manager.sessions.find((x) => x.id === id);

    if (session === undefined) {
      return 'missing';
    }

    const adapter = this.manager.findAdapter(session.agent);

    if (adapter === null || adapter.headlessRunner === null) {
      return 'unsupported';
    }

    if (!hasResumableTranscript(this.manager, id)) {
      return 'no_transcript';
    }

    this.manager.requireExecution(session, 'kill');
    this.manager.requireExecution(session, 'headless');

    // Refused before the terminal stops, so a refusal leaves it running.
    requireSessionPluginDirs(this.manager, session);

    const yanked = this.manager.yankHeadless(id);

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
    if (!hasResumableTranscript(this.manager, id)) {
      return 'no_transcript';
    }

    const listed = this.manager.sessions.find((session) => session.id === id);

    // Refused before the headless run stops, so a refusal leaves it as
    // it was.
    if (listed !== undefined) {
      this.manager.requireAgentTarget(listed.agent, listed.target);

      requireSessionPluginDirs(this.manager, listed);
    }

    this.findRuntime(id)?.stopHeadlessRun();

    const adopted = await this.manager.adoptTerminal(
      id,
      cols,
      rows,
      () => access === null || isTreeInReach(this.manager.sessions, id, access),
    );

    if (adopted === null) {
      return 'missing';
    }

    this.scheduleResize(id);

    return 'ok';
  }
}
