import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTestCleanup } from './register-test-cleanup';

interface TempDir {
  readonly dir: string;
  readonly teardown: () => void;
}

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
