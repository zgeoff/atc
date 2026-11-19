import { readCleanEnv } from '@atc/config';
import { buildSessionEnv } from '@atc/protocol/session';
import type { SessionID } from '@atcx/contract';

interface HeadlessEnvParams {
  readonly pluginDir?: string;
  readonly sessionID?: SessionID;
  readonly socketPath: string;

  readonly withheldEnv?: readonly string[];

  readonly recordPath?: string;
}

export function buildHeadlessEnv(params: HeadlessEnvParams): Record<string, string> {
  const inherited = readCleanEnv({}, params.withheldEnv);

  return {
    ...inherited,
    ...(params.pluginDir === undefined ? {} : { CLAUDE_CODE_PLUGIN_DIRS: params.pluginDir }),
    ...buildSessionEnv({
      ...(params.sessionID === undefined
        ? {}
        : { sessionID: params.sessionID, socket: params.socketPath }),
      ...(params.recordPath === undefined ? {} : { sessionRecord: params.recordPath }),
      inheritedEnv: inherited,
    }),
  };
}
