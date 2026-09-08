import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface TempDir {
  readonly dir: string;
  readonly [Symbol.dispose]: () => void;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * Creates a disposable directory under the system temp root, named by the
 * prefix. Disposal removes the tree; hold the result with `using` in a
 * synchronous test and `await using` in an asynchronous one, so the
 * directory outlives exactly the test that made it.
 */
export function setupTempDir(prefix: string): TempDir {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  const remove = () => {
    rmSync(dir, { recursive: true, force: true });
  };

  return {
    dir,
    [Symbol.dispose]: remove,
    [Symbol.asyncDispose]: () => {
      remove();

      return Promise.resolve();
    },
  };
}
