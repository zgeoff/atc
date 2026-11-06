import { posix } from 'node:path';
import type { ExecutionProvider } from '@atc/plugin-api';

// prints the path of each folder directly under a folder, and of no symlink, each followed by a
// NUL, so a name holding a newline stays whole; a folder that is not there has none
export const LIST_SUBDIRS_SCRIPT = String.raw`[ -d "$1" ] || exit 0; find "$1" -mindepth 1 -maxdepth 1 -type d -exec printf '%s\0' {} +`;

// The folders directly under an absolute folder on a host, or none when the host did not answer.
export async function readHostSubdirs(
  provider: Pick<ExecutionProvider, 'runCommand'>,
  host: string | null,
  directory: string,
): Promise<string[]> {
  const run = await provider
    .runCommand({
      argv: ['sh', '-c', LIST_SUBDIRS_SCRIPT, 'sh', directory],
      cwd: '/',
      ...(host === null ? {} : { host }),
    })
    .catch(() => null);

  if (run?.exitCode !== 0) {
    return [];
  }

  return run.stdout
    .split('\0')
    .filter((path) => path !== '')
    .map((path) => posix.normalize(path));
}
