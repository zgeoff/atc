import type { SessionID } from '@atc/core';
import { truncateDetail, truncateSummary } from '@atc/core';
import type { AdapterEvent } from '@atc/protocol';
import type { SessionRuntime } from './session-runtime';
import type { SessionManager } from './sessions';

export function startHeadlessTurn(
  mgr: SessionManager,
  findRuntime: (sessionID: SessionID) => SessionRuntime | undefined,
  sessionID: SessionID,
  prompt: string,
  recordTurnEvent: (sessionID: SessionID, ev: Readonly<AdapterEvent>) => void,
  reporterSocket: string,
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
      reporterSocket,
      ...(s.model === undefined ? {} : { model: s.model }),
      ...(s.effort === undefined ? {} : { effort: s.effort }),
      ...(s.pluginDirs === undefined ? {} : { pluginDirs: s.pluginDirs }),
      ...(s.withheldEnv.length === 0 ? {} : { withheldEnv: s.withheldEnv }),
      ...(mgr.records === null || mgr.findProvider(s)?.remote !== false
        ? {}
        : { recordPath: mgr.records.getLocalPath(sessionID) }),
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

  // A runner that throws before it returns leaves the mark, so a later
  // restore still tries the session again.
  mgr.removeUnrestoredMark(sessionID);

  return true;
}
