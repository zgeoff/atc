import { posix } from 'node:path';

// Enters the directory given first from the home, then runs the rest in its
// place. `./` keeps a directory named `-` from meaning the previous one, and
// keeps any CDPATH entry from standing in for it.
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
