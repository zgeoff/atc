import { posix } from 'node:path';

// `./` stops a directory named `-` from meaning the previous directory, and stops a
// CDPATH entry from being entered in its place.
export const ENTER_FROM_HOME_SCRIPT = 'cd && cd -P -- "./$0" && exec "$@"';

export function buildHomeRelativeCommand(
  argv: readonly string[],
  cwd: string,
): { readonly argv: readonly string[]; readonly cwd: string } {
  if (posix.isAbsolute(cwd)) {
    return { argv, cwd };
  }

  return { argv: ['sh', '-c', ENTER_FROM_HOME_SCRIPT, cwd, ...argv], cwd: '/' };
}
