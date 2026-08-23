import type { SessionID } from '../shared/session-id';
import type { SessionRuntime } from './session-runtime';
import type { SessionManager } from './sessions';

/**
 * Starts one headless turn for a session: finds its adapter's headless
 * runner, wires the run's output and completion into the session manager,
 * and records the live handle on the session's runtime. Returns false
 * without starting anything when the session is unknown, its agent has no
 * headless runner, or a turn is already running.
 */
export function startHeadlessTurn(
  mgr: SessionManager,
  findRuntime: (sessionID: SessionID) => SessionRuntime | undefined,
  sessionID: SessionID,
  prompt: string,
): boolean {
  const s = mgr.sessions.find((x) => x.id === sessionID);
  const runner = s === undefined ? null : (mgr.findAdapter(s.agent)?.headlessRunner ?? null);
  const runtime = findRuntime(sessionID);

  if (s === undefined || runner === null || runtime === undefined || runtime.headlessRun !== null) {
    return false;
  }

  mgr.updateSurfaceState(sessionID, 'running', 'headless turn running');

  const handle = runner(
    {
      cwd: s.cwd,
      prompt,
      ...(s.agentSessionID === undefined ? {} : { resume: s.agentSessionID }),
      permissionMode: 'auto',
    },
    {
      onOutput: (text) => {
        mgr.onOutput(s, text);
      },
      onDone: (summary) => {
        runtime.headlessRun = null;

        const doneMsg = summary === '' ? 'headless turn done' : summary;

        mgr.updateSurfaceState(sessionID, 'done', doneMsg);
      },
      onNeedsYou: (msg) => {
        runtime.headlessRun = null;

        mgr.updateSurfaceState(sessionID, 'needs_you', msg);
      },
    },
  );

  runtime.headlessRun = handle;

  return true;
}
