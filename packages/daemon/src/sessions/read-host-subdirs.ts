import { posix } from 'node:path';
import type { ExecutionProvider } from '@atc/plugin-api';

// prints each folder directly under a folder, and no symlink, NUL-ended; `test -e` is false for a
// missing path and for one under a folder sh cannot search, so the folder counts as missing only
// when the nearest path that exists is a folder sh can search
export const LIST_SUBDIRS_SCRIPT = String.raw`
d=$1
while [ ! -e "$d" ] && [ ! -L "$d" ]; do d=$(dirname "$d"); done
if [ "$d" != "$1" ]; then
  if [ -d "$d" ] && [ -x "$d" ]; then exit 0; fi
  printf 'atc cannot reach %s: %s is not a folder it can search\n' "$1" "$d" >&2
  exit 1
fi
find "$1/" -mindepth 1 -maxdepth 1 -type d -exec printf '%s\0' {} +`;

// The folders directly under an absolute folder on a host; rejects with the host's error when it
// could not list them, so a failed listing never reads as an empty folder.
export async function readHostSubdirs(
  provider: Pick<ExecutionProvider, 'runCommand'>,
  directory: string,
): Promise<string[]> {
  const run = await provider.runCommand({
    argv: ['sh', '-c', LIST_SUBDIRS_SCRIPT, 'sh', directory],
    cwd: '/',
  });

  if (run.exitCode !== 0) {
    throw new Error(`atc could not list the folders under ${directory}: ${run.stderr.trim()}`);
  }

  return run.stdout
    .split('\0')
    .filter((path) => path !== '')
    .map((path) => posix.normalize(path));
}
