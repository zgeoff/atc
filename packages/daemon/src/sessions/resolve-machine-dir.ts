import { realpathSync } from 'node:fs';
import { posix } from 'node:path';

// An absolute directory on the daemon's own machine with every symlink in
// it resolved, through its nearest existing directory.
export function resolveMachineDir(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    const parent = posix.dirname(directory);

    return parent === directory
      ? directory
      : posix.join(resolveMachineDir(parent), posix.basename(directory));
  }
}
