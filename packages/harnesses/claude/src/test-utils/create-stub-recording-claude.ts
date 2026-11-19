import { join } from 'node:path';
import { createStubBin } from '@atc/core/test-utils/create-stub-bin';

export function createStubRecordingClaude(directory: string): string {
  const log = join(directory, 'claude-starts.log');

  return createStubBin(
    directory,
    'fake-claude',
    `#!/bin/sh\n{ printf '%s\\n' "$@"; echo; } >> '${log}'\nexec sleep 30\n`,
  );
}
