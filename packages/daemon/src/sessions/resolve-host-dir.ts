import { posix } from 'node:path';
import type { ExecutionProvider } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';

// prints the nearest existing directory with every symlink resolved and a newline, which keeps a
// name ending in newlines whole, then a NUL and the rest of the path as given
export const RESOLVE_DIR_SCRIPT = `p=$1; s=; while [ ! -d "$p" ]; do s=/\${p##*/}$s; p=\${p%/*}; [ -n "$p" ] || p=/; done; cd -P -- "$p" && pwd -P && printf '\\0%s' "$s"`;

// Resolves a directory as the script above does, but fails when any part
// of it that is not an existing directory is a symlink, such as one whose
// target was removed, since the directory it stands for could lie anywhere.
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
