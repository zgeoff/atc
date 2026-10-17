import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';

// The log exists only once a start has run, so its absence proves no harness
// started.
export function createStubRecordingClaude(dir: string): string {
  const log = join(dir, 'claude-starts.log');

  return createStubBin(
    dir,
    'fake-claude',
    `#!/bin/sh\n{ printf '%s\\n' "$@"; echo; } >> '${log}'\nexec sleep 30\n`,
  );
}
