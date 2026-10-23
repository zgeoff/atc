import { truncateDetail, truncateSummary } from '@atc/core';
import type { AdapterEvent } from '@atc/protocol';
import type { SessionID } from '@atcx/contract';
import type { SessionManager } from './create-session-manager';
import type { SessionRuntime } from './create-session-runtime';

interface StartHeadlessTurnOptions {
  readonly manager: SessionManager;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;
  readonly sessionID: SessionID;
  readonly prompt: string;
  readonly recordTurnEvent: (sessionID: SessionID, ev: Readonly<AdapterEvent>) => void;
  readonly reporterSocket: string;
}

export function startHeadlessTurn(options: StartHeadlessTurnOptions): boolean {
  const session = options.manager.sessions.find((x) => x.id === options.sessionID);

  const runner =
    session === undefined
      ? null
      : (options.manager.findAdapter(session.agent)?.headlessRunner ?? null);

  const runtime = options.findRuntime(options.sessionID);

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
  if (
    session.state === 'exited' ||
    options.manager.findExecutionRefusal(session, 'headless') !== null
  ) {
    return false;
  }

  options.manager.updateSurfaceState(options.sessionID, 'running', 'headless turn running');

  options.recordTurnEvent(options.sessionID, {
    kind: 'prompt-submitted',
    detail: truncateDetail(options.prompt),
  });

  const handle = runner(
    {
      cwd: session.cwd,
      prompt: options.prompt,
      ...(session.agentSessionID === undefined ? {} : { resume: session.agentSessionID }),
      sessionID: options.sessionID,
      reporterSocket: options.reporterSocket,
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.effort === undefined ? {} : { effort: session.effort }),
      ...(session.pluginDirs === undefined ? {} : { pluginDirs: session.pluginDirs }),
      ...(session.withheldEnv.length === 0 ? {} : { withheldEnv: session.withheldEnv }),
      ...(options.manager.records === null ||
      options.manager.findProvider(session)?.remote !== false
        ? {}
        : { recordPath: options.manager.records.getLocalPath(options.sessionID) }),
    },
    {
      onOutput: (text) => {
        options.manager.onOutput(session, text);
      },
      onDone: (result) => {
        runtime.headlessRun = null;

        const summary = truncateSummary(result);
        const doneMsg = summary === '' ? 'headless turn done' : summary;

        options.manager.updateSurfaceState(options.sessionID, 'done', doneMsg, result);

        options.recordTurnEvent(options.sessionID, {
          kind: 'turn-done',
          detail: truncateDetail(result),
        });
      },
      onNeedsYou: (message) => {
        runtime.headlessRun = null;

        options.manager.updateSurfaceState(options.sessionID, 'needs_you', message);

        options.recordTurnEvent(options.sessionID, {
          kind: 'needs-input',
          message,
          detail: message,
        });
      },
    },
  );

  runtime.headlessRun = handle;

  // A runner that throws before it returns leaves the mark, so a later
  // restore still tries the session again.
  options.manager.removeUnrestoredMark(options.sessionID);

  return true;
}
