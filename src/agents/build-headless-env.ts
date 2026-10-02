import { collectCleanEnv } from '../shared/collect-clean-env';
import type { SessionID } from '../shared/session-id';

interface HeadlessEnvParams {
  readonly pluginDir?: string;
  readonly sessionID?: SessionID;
  readonly socketPath: string;
}

/**
 * The clean process environment for a headless run, plus what the atc-bridge
 * mod needs to find its session: the mod folder to load and the session and
 * reporter socket it taps. A run without a session id carries none of them,
 * since the mod stays off outside atc.
 */
export function buildHeadlessEnv(params: HeadlessEnvParams): Record<string, string> {
  return collectCleanEnv({
    ...(params.pluginDir === undefined ? {} : { CLAUDE_CODE_PLUGIN_DIRS: params.pluginDir }),
    ...(params.sessionID === undefined
      ? {}
      : { ATC_SESSION_ID: params.sessionID, ATC_SOCKET: params.socketPath }),
  });
}
