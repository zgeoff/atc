import type { SessionID } from '@atc/core';
import { truncateDetail, truncateSummary } from '@atc/core';
import type { AdapterEvent } from '@atc/protocol';
import type { SessionRuntime } from './session-runtime';
import type { SessionManager } from './sessions';

export function startHeadlessTurn(
  manager: SessionManager,
  findRuntime: (sessionID: SessionID) => SessionRuntime | undefined,
  sessionID: SessionID,
  prompt: string,
  recordTurnEvent: (sessionID: SessionID, ev: Readonly<AdapterEvent>) => void,
  reporterSocket: string,
): boolean {
  const session = manager.sessions.find((x) => x.id === sessionID);

  const runner =
    session === undefined ? null : (manager.findAdapter(session.agent)?.headlessRunner ?? null);

  const runtime = findRuntime(sessionID);

  if (
    session === undefined ||
    runner === null ||
    runtime === undefined ||
    runtime.headlessRun !== null
  ) {
    return false;
  }

  // The runner runs on the daemon's own host, so a session whose target
  // does not serve headless turns never reaches it.
  if (session.state === 'exited' || manager.findExecutionRefusal(session, 'headless') !== null) {
    return false;
  }

  manager.updateSurfaceState(sessionID, 'running', 'headless turn running');

  recordTurnEvent(sessionID, { kind: 'prompt-submitted', detail: truncateDetail(prompt) });

  const handle = runner(
    {
      cwd: session.cwd,
      prompt,
      ...(session.agentSessionID === undefined ? {} : { resume: session.agentSessionID }),
      sessionID,
      reporterSocket,
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.effort === undefined ? {} : { effort: session.effort }),
      ...(session.pluginDirs === undefined ? {} : { pluginDirs: session.pluginDirs }),
      ...(session.withheldEnv.length === 0 ? {} : { withheldEnv: session.withheldEnv }),
      ...(manager.records === null || manager.findProvider(session)?.remote !== false
        ? {}
        : { recordPath: manager.records.getLocalPath(sessionID) }),
    },
    {
      onOutput: (text) => {
        manager.onOutput(session, text);
      },
      onDone: (result) => {
        runtime.headlessRun = null;

        const summary = truncateSummary(result);
        const doneMsg = summary === '' ? 'headless turn done' : summary;

        manager.updateSurfaceState(sessionID, 'done', doneMsg, result);

        recordTurnEvent(sessionID, { kind: 'turn-done', detail: truncateDetail(result) });
      },
      onNeedsYou: (message) => {
        runtime.headlessRun = null;

        manager.updateSurfaceState(sessionID, 'needs_you', message);

        recordTurnEvent(sessionID, { kind: 'needs-input', message, detail: message });
      },
    },
  );

  runtime.headlessRun = handle;

  // A runner that throws before it returns leaves the mark, so a later
  // restore still tries the session again.
  manager.removeUnrestoredMark(sessionID);

  return true;
}
