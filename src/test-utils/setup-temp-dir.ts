import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTestCleanup } from './register-test-cleanup';

interface TempDir {
  readonly dir: string;
  readonly teardown: () => void;
}

/**
 * Creates a directory under the system temp root, named by the prefix, and
 * registers its removal to run once the current test finishes, so it must
 * run inside a test. `teardown` removes the tree sooner; whichever comes
 * second does nothing.
 */
export function setupTempDir(prefix: string): TempDir {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  const teardown = registerTestCleanup(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    teardown,
  };
}
