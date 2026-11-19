import { posix } from 'node:path';
import { ENTER_FROM_HOME_SCRIPT } from '../guest-scripts/enter-from-home-script';

// The exec fails on a missing working directory, so the shell enters a relative one itself.
export function buildHomeRelativeCommand(
  argv: readonly string[],
  cwd: string,
): { readonly argv: readonly string[]; readonly cwd: string } {
  if (posix.isAbsolute(cwd)) {
    return { argv, cwd };
  }

  return { argv: ['sh', '-c', ENTER_FROM_HOME_SCRIPT, cwd, ...argv], cwd: '/' };
}
