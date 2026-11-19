import { posix } from 'node:path';

// `./` stops cd from reading a directory named `-` as the previous directory, and stops it
// from resolving the name through a CDPATH entry instead.
export const ENTER_FROM_HOME_SCRIPT = 'cd && cd -P -- "./$0" && exec "$@"';

// A relative directory lies under the home of the image's user, and the shell enters it, since the
// Engine would create a missing working directory as root.
export function buildHomeRelativeCommand(
  argv: readonly string[],
  cwd: string,
): { readonly argv: readonly string[]; readonly cwd: string } {
  if (posix.isAbsolute(cwd)) {
    return { argv, cwd };
  }

  return { argv: ['sh', '-c', ENTER_FROM_HOME_SCRIPT, cwd, ...argv], cwd: '/' };
}
