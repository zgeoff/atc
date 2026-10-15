import { posix } from 'node:path';

// Enters the directory given first from the home of the user it runs as,
// then runs the rest of its arguments in its place.
const ENTER_FROM_HOME_SCRIPT = 'cd && cd -P -- "$0" && exec "$@"';

/**
 * A process for impd to start, whose relative working directory lies under
 * the home of the user it runs as. impd starts a process in a relative
 * directory from the root, where its agent runs, so a relative one goes
 * over as a shell that starts at the root, enters the directory from the
 * home, and runs the process there. An absolute directory goes over as it
 * stands.
 */
export function buildHomeRelativeCommand(
  argv: readonly string[],
  cwd: string,
): { readonly argv: readonly string[]; readonly cwd: string } {
  if (posix.isAbsolute(cwd)) {
    return { argv, cwd };
  }

  return { argv: ['sh', '-c', ENTER_FROM_HOME_SCRIPT, cwd, ...argv], cwd: '/' };
}
