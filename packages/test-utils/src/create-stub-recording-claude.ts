import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';

// The log exists only once a start has run, so its absence proves no harness
// started.
export function createStubRecordingClaude(directory: string): string {
  const log = join(directory, 'claude-starts.log');

  return createStubBin(
    directory,
    'fake-claude',
    `#!/bin/sh\n{ printf '%s\\n' "$@"; echo; } >> '${log}'\nexec sleep 30\n`,
  );
}
