import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';

/**
 * Creates a stand-in for the Codex CLI as `fake-codex` under the directory
 * and returns its path. Each start appends one line to `codex-starts.log`
 * under the same directory: the `CODEX_HOME` it started with, then its
 * arguments, separated by spaces. It then stays up without reporting
 * anything. The log exists only once a start has run, so a test proves that
 * no harness started by its absence.
 */
export function createStubRecordingCodex(dir: string): string {
  const log = join(dir, 'codex-starts.log');

  return createStubBin(
    dir,
    'fake-codex',
    `#!/bin/sh\necho "$CODEX_HOME $*" >> '${log}'\nexec sleep 30\n`,
  );
}
