import { posix } from 'node:path';
import type { AgentHomeLocation, ExecutionProvider } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';

export const RESOLVE_AGENT_HOME_SCRIPT = `home=$(printenv "$1") && [ -n "$home" ] && { printf '%s\\n' "$home"; exit 0; }
cd && printf '%s/%s\\n' "$(pwd -P)" "$2"`;

// The harness starts the agent with the launch env layered over the host's inherited env, so
// the agent sees the launch value.
export async function readHostAgentHome(
  provider: Pick<ExecutionProvider, 'runCommand'>,
  hostKey: SessionID,
  location: AgentHomeLocation,
  launchEnv: Readonly<Record<string, string>>,
): Promise<string> {
  const planned = launchEnv[location.env];

  if (planned !== undefined && planned !== '') {
    return planned;
  }

  const result = await provider.runCommand({
    argv: ['sh', '-c', RESOLVE_AGENT_HOME_SCRIPT, 'sh', location.env, location.folder],
    cwd: '/',
    host: hostKey,
  });

  const home = result.stdout.replace(/\n$/u, '');

  if (result.exitCode !== 0 || !posix.isAbsolute(home)) {
    throw new AtcError(
      'host_unavailable',
      `the host of session ${hostKey} cannot resolve the home of its agent: ${result.stderr.trim()}`,
      { phase: 'resolving' },
    );
  }

  return home;
}
