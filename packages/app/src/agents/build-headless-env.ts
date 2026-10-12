import type { SessionID } from '@atc/core/session-id';
import { buildSessionEnv } from '@atc/protocol/build-session-env';
import { collectCleanEnv } from '../shared/collect-clean-env';

interface HeadlessEnvParams {
  readonly pluginDir?: string;
  readonly sessionID?: SessionID;
  readonly socketPath: string;

  // Variables the run goes without, such as a workspace credential.
  readonly withheldEnv?: readonly string[];

  // Where the session's published record lies.
  readonly recordPath?: string;
}

/**
 * The clean process environment for a headless run, plus what the atc-bridge
 * mod needs to find its session: the mod folder to load and the session and
 * reporter socket it taps. A run without a session id carries none of them,
 * since the mod stays off outside atc.
 */
export function buildHeadlessEnv(params: HeadlessEnvParams): Record<string, string> {
  return collectCleanEnv(
    {
      ...(params.pluginDir === undefined ? {} : { CLAUDE_CODE_PLUGIN_DIRS: params.pluginDir }),
      ...buildSessionEnv({
        ...(params.sessionID === undefined
          ? {}
          : { sessionID: params.sessionID, socket: params.socketPath }),
        ...(params.recordPath === undefined ? {} : { sessionRecord: params.recordPath }),
      }),
    },
    params.withheldEnv,
  );
}
