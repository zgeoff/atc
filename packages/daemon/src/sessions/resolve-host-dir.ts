import { posix } from 'node:path';
import type { ExecutionProvider } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';

// A trailing newline in a directory name would be lost when the output is captured, so the
// resolved directory is followed by a NUL and the unresolved rest of the path comes after it.
export const RESOLVE_DIR_SCRIPT = `p=$1; s=; while [ ! -d "$p" ]; do s=/\${p##*/}$s; p=\${p%/*}; [ -n "$p" ] || p=/; done; cd -P -- "$p" && pwd -P && printf '\\0%s' "$s"`;

// A symlink whose target is missing could stand for a directory anywhere, so the script exits
// with status 6 instead of treating it as a plain missing name.
export const RESOLVE_UNLINKED_DIR_SCRIPT = `p=$1; while [ ! -d "$p" ]; do [ ! -L "$p" ] || exit 6; p=\${p%/*}; [ -n "$p" ] || p=/; done; ${RESOLVE_DIR_SCRIPT}`;

export async function resolveHostDir(
  provider: ExecutionProvider,
  hostKey: SessionID | null,
  directory: string,
  script: string = RESOLVE_DIR_SCRIPT,
): Promise<string> {
  const absolute = posix.isAbsolute(directory);

  const result = await provider.runCommand({
    argv: ['sh', '-c', script, 'sh', absolute ? posix.normalize(directory) : '.'],
    cwd: absolute ? '/' : directory,
    ...(hostKey === null ? {} : { host: hostKey }),
  });

  const split = result.stdout.lastIndexOf('\0');

  if (result.exitCode !== 0 || split < 1 || result.stdout[split - 1] !== '\n') {
    throw new DaemonError(
      'host_unavailable',
      `${hostKey === null ? 'the daemon host' : `the host of session ${hostKey}`} cannot resolve ${directory}: ${result.stderr.trim()}`,
      { phase: 'resolving', directory },
    );
  }

  const existing = result.stdout.slice(0, split - 1);
  const rest = result.stdout.slice(split + 1);

  return existing === '/' ? rest || '/' : `${existing}${rest}`;
}
