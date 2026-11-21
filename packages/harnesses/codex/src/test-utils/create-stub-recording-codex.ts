import { join } from 'node:path';
import { writeStubProgram } from '@atc/core/test-utils/write-stub-program';

export function createStubRecordingCodex(directory: string): string {
  const log = join(directory, 'codex-starts.log');

  return writeStubProgram(
    directory,
    'fake-codex',
    `#!/bin/sh\necho "$CODEX_HOME $*" >> '${log}'\nexec sleep 30\n`,
  );
}
