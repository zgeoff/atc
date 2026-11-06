import { posix } from 'node:path';
import type { ExecutionProvider } from '@atc/plugin-api';

// prints the path of each folder directly under a folder, and of no symlink, each followed by a
// NUL, so a name holding a newline stays whole; a folder that is not there has none
export const LIST_SUBDIRS_SCRIPT = String.raw`[ -d "$1" ] || exit 0; find "$1" -mindepth 1 -maxdepth 1 -type d -exec printf '%s\0' {} +`;

// The folders directly under an absolute folder on a host; rejects with the host's error when it
// could not list them, so a failed listing never reads as an empty folder.
export async function readHostSubdirs(
  provider: Pick<ExecutionProvider, 'runCommand'>,
  host: string | null,
  directory: string,
): Promise<string[]> {
  const run = await provider.runCommand({
    argv: ['sh', '-c', LIST_SUBDIRS_SCRIPT, 'sh', directory],
    cwd: '/',
    ...(host === null ? {} : { host }),
  });

  if (run.exitCode !== 0) {
    throw new Error(`atc could not list the folders under ${directory}: ${run.stderr.trim()}`);
  }

  return run.stdout
    .split('\0')
    .filter((path) => path !== '')
    .map((path) => posix.normalize(path));
}
