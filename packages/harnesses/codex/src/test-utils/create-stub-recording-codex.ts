import { join } from 'node:path';
import { createStubBin } from '@atc/core/test-utils/create-stub-bin';

export function createStubRecordingCodex(directory: string): string {
  const log = join(directory, 'codex-starts.log');

  return createStubBin(
    directory,
    'fake-codex',
    `#!/bin/sh\necho "$CODEX_HOME $*" >> '${log}'\nexec sleep 30\n`,
  );
}
