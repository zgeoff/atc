import { collectCleanEnv } from '@atc/config';
import type { SessionID } from '@atc/core';
import { buildSessionEnv } from '@atc/protocol/session';

interface HeadlessEnvParams {
  readonly pluginDir?: string;
  readonly sessionID?: SessionID;
  readonly socketPath: string;

  // Variables the run goes without, such as a workspace credential.
  readonly withheldEnv?: readonly string[];

  // Where the session's published record lies.
  readonly recordPath?: string;
}

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
