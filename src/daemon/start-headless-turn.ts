import type { AdapterEvent } from '../agents/agent-adapter';
import { truncateDetail } from '../agents/truncate-detail';
import type { SessionID } from '../shared/session-id';
import type { SessionRuntime } from './session-runtime';
import type { SessionManager } from './sessions';
import { truncateSummary } from './truncate-summary';

/**
 * Starts one headless turn for a session: finds its adapter's headless
 * runner, wires the run's output and completion into the session manager,
 * passes the turn's start and end to the event trail the way a terminal
 * turn's hooks do, and records the live handle on the session's runtime. Returns false
 * without starting anything when the session is unknown or exited, its
 * agent has no headless runner, its target does not serve headless turns,
 * or a turn is already running.
 */
export function startHeadlessTurn(
  mgr: SessionManager,
  findRuntime: (sessionID: SessionID) => SessionRuntime | undefined,
  sessionID: SessionID,
  prompt: string,
  recordTurnEvent: (sessionID: SessionID, ev: Readonly<AdapterEvent>) => void,
): boolean {
  const s = mgr.sessions.find((x) => x.id === sessionID);
  const runner = s === undefined ? null : (mgr.findAdapter(s.agent)?.headlessRunner ?? null);
  const runtime = findRuntime(sessionID);

  if (s === undefined || runner === null || runtime === undefined || runtime.headlessRun !== null) {
    return false;
  }

  // The runner runs on the daemon's own host, so a session whose target
  // does not serve headless turns never reaches it.
  if (s.state === 'exited' || mgr.findExecutionRefusal(s, 'headless') !== null) {
    return false;
  }

  mgr.updateSurfaceState(sessionID, 'running', 'headless turn running');

  recordTurnEvent(sessionID, { kind: 'prompt-submitted', detail: truncateDetail(prompt) });

  const handle = runner(
    {
      cwd: s.cwd,
      prompt,
      ...(s.agentSessionID === undefined ? {} : { resume: s.agentSessionID }),
      sessionID,
      ...(s.model === undefined ? {} : { model: s.model }),
      ...(s.effort === undefined ? {} : { effort: s.effort }),
      ...(s.withheldEnv.length === 0 ? {} : { withheldEnv: s.withheldEnv }),
    },
    {
      onOutput: (text) => {
        mgr.onOutput(s, text);
      },
      onDone: (result) => {
        runtime.headlessRun = null;

        const summary = truncateSummary(result);
        const doneMsg = summary === '' ? 'headless turn done' : summary;

        mgr.updateSurfaceState(sessionID, 'done', doneMsg, result);

        recordTurnEvent(sessionID, { kind: 'turn-done', detail: truncateDetail(result) });
      },
      onNeedsYou: (msg) => {
        runtime.headlessRun = null;

        mgr.updateSurfaceState(sessionID, 'needs_you', msg);

        recordTurnEvent(sessionID, { kind: 'needs-input', message: msg, detail: msg });
      },
    },
  );

  runtime.headlessRun = handle;

  return true;
}
