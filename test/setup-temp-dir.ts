import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface TempDir {
  readonly dir: string;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * Creates a disposable directory under the system temp root, named by the
 * prefix. Disposal removes the tree; hold the result with `await using` so
 * the directory outlives exactly the test that made it.
 */
export function setupTempDir(prefix: string): TempDir {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  return {
    dir,
    [Symbol.asyncDispose]: () => {
      rmSync(dir, { recursive: true, force: true });

      return Promise.resolve();
    },
  };
}
