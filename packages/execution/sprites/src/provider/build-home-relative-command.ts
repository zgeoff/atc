import { posix } from 'node:path';
import { ENTER_FROM_HOME_SCRIPT } from '../guest-scripts/enter-from-home-script';

// A relative directory lies under the home of the sprite's user, and the shell enters it, since
// the exec would take a missing working directory as an error.
export function buildHomeRelativeCommand(
  argv: readonly string[],
  cwd: string,
): { readonly argv: readonly string[]; readonly cwd: string } {
  if (posix.isAbsolute(cwd)) {
    return { argv, cwd };
  }

  return { argv: ['sh', '-c', ENTER_FROM_HOME_SCRIPT, cwd, ...argv], cwd: '/' };
}
