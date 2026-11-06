import { posix } from 'node:path';
import type { ExecutionProvider } from '@atc/plugin-api';

// prints each folder directly under a folder, and no symlink, NUL-ended. A failed `test` cannot
// tell a missing path from an error such as a name too long, so the script reads find's errors,
// in the C locale, and counts the folder as missing only when every one is ENOENT
export const LIST_SUBDIRS_SCRIPT = String.raw`
LC_ALL=C
export LC_ALL
{ errors=$(find "$1/" -mindepth 1 -maxdepth 1 -type d -exec printf '%s\0' {} + 2>&1 >&3 3>&-); status=$?; } 3>&1
[ "$status" -eq 0 ] && exit 0
printf '%s\n' "$errors" | grep -qv ': No such file or directory$' || exit 0
printf '%s\n' "$errors" >&2
exit 1`;

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
