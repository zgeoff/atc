import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';

// The log exists only once a start has run, so its absence proves no harness
// started.
export function createStubRecordingCodex(directory: string): string {
  const log = join(directory, 'codex-starts.log');

  return createStubBin(
    directory,
    'fake-codex',
    `#!/bin/sh\necho "$CODEX_HOME $*" >> '${log}'\nexec sleep 30\n`,
  );
}
