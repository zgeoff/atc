import { join } from 'node:path';
import { writeStubProgram } from '@atc/core/test-utils/write-stub-program';

export function createStubRecordingClaude(directory: string): string {
  const log = join(directory, 'claude-starts.log');

  return writeStubProgram(
    directory,
    'fake-claude',
    `#!/bin/sh\n{ printf '%s\\n' "$@"; echo; } >> '${log}'\nexec sleep 30\n`,
  );
}
