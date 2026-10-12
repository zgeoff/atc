import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';

/**
 * Creates a stand-in for the Claude CLI as `fake-claude` under the
 * directory and returns its path. Each start appends its arguments to
 * `claude-starts.log` under the same directory, one per line, ends the
 * start with an empty line, and then stays up without reporting anything,
 * as a session whose agent never speaks does. The log exists only once a
 * start has run, so a test proves that no harness started by its absence.
 */
export function createStubRecordingClaude(dir: string): string {
  const log = join(dir, 'claude-starts.log');

  return createStubBin(
    dir,
    'fake-claude',
    `#!/bin/sh\n{ printf '%s\\n' "$@"; echo; } >> '${log}'\nexec sleep 30\n`,
  );
}
