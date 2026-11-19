import { posix } from 'node:path';
import type { ExecutionProvider } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';

export const RESOLVE_HOME_SCRIPT = 'cd && pwd -P';

export async function resolveHostHome(
  provider: ExecutionProvider,
  hostKey: SessionID,
): Promise<string> {
  const result = await provider.runCommand({
    argv: ['sh', '-c', RESOLVE_HOME_SCRIPT],
    cwd: '/',
    host: hostKey,
  });

  const home = result.stdout.replace(/\n$/u, '');

  if (result.exitCode !== 0 || !posix.isAbsolute(home)) {
    throw new DaemonError(
      'host_unavailable',
      `the host of session ${hostKey} cannot resolve its home directory: ${result.stderr.trim()}`,
      { phase: 'resolving' },
    );
  }

  return home;
}
