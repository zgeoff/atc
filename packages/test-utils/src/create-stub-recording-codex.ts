import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';

// The log exists only once a start has run, so its absence proves no harness
// started.
export function createStubRecordingCodex(dir: string): string {
  const log = join(dir, 'codex-starts.log');

  return createStubBin(
    dir,
    'fake-codex',
    `#!/bin/sh\necho "$CODEX_HOME $*" >> '${log}'\nexec sleep 30\n`,
  );
}
