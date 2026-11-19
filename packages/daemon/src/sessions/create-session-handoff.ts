import type { SessionID } from '@atcx/contract';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import { isTreeInReach } from '../auth/is-tree-in-reach';
import type { SessionManager } from './create-session-manager';
import type { SessionRuntime } from './create-session-runtime';
import { hasResumableTranscript } from './has-resumable-transcript';
import { requireSessionPluginDirs } from './require-session-plugin-dirs';
import { runEjectHandoff } from './run-eject-handoff';
import type { SettleScheduler } from './run-eject-handoff';

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

  readonly ejectSettleMs: number;
  readonly scheduleEjectSettle: SettleScheduler;

  readonly startHeadlessTurn: (sessionID: SessionID, prompt: string) => boolean;

  readonly scheduleResize: (sessionID: SessionID) => void;
}

export interface SessionHandoff {
  readonly yankSession: (
    id: SessionID,
    prompt: string,
  ) => 'ok' | 'missing' | 'unsupported' | 'no_transcript';

  readonly adoptSession: (
    id: SessionID,
    cols: number,
    rows: number,
    access: TargetAccess | null,
  ) => Promise<'ok' | 'missing' | 'no_transcript'>;
}

export function createSessionHandoff(deps: SessionHandoffDeps): SessionHandoff {
  const manager = deps.manager;
  const findRuntime = deps.findRuntime;
  const ejectSettleMs = deps.ejectSettleMs;
  const scheduleEjectSettle = deps.scheduleEjectSettle;
  const startHeadlessTurn = deps.startHeadlessTurn;
  const scheduleResize = deps.scheduleResize;

  return {
    yankSession: (id, prompt) => {
      const session = manager.sessions.find((x) => x.id === id);

      if (session === undefined) {
        return 'missing';
      }

      const adapter = manager.findAdapter(session.agent);

      if (adapter === null || adapter.headlessRunner === null) {
        return 'unsupported';
      }

      if (!hasResumableTranscript(manager, id)) {
        return 'no_transcript';
      }

      manager.requireExecution(session, 'kill');
      manager.requireExecution(session, 'headless');

      requireSessionPluginDirs(manager, session);

      const yanked = manager.yankHeadless(id);

      if (yanked === null) {
        return 'missing';
      }

      const runtime = findRuntime(id);

      if (runtime === undefined) {
        return 'missing';
      }

      runEjectHandoff({
        sessionID: id,
        prompt,
        settleMs: ejectSettleMs,
        scheduleSettle: scheduleEjectSettle,
        runtime,
        startHeadlessTurn,
      });

      return 'ok';
    },

    adoptSession: async (id, cols, rows, access) => {
      if (!hasResumableTranscript(manager, id)) {
        return 'no_transcript';
      }

      const listed = manager.sessions.find((session) => session.id === id);

      if (listed !== undefined) {
        manager.requireAgentTarget(listed.agent, listed.target);

        requireSessionPluginDirs(manager, listed);
      }

      findRuntime(id)?.stopHeadlessRun();

      const adopted = await manager.adoptTerminal(
        id,
        cols,
        rows,
        () => access === null || isTreeInReach(manager.sessions, id, access),
      );

      if (adopted === null) {
        return 'missing';
      }

      scheduleResize(id);

      return 'ok';
    },
  };
}
