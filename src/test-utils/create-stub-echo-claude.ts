import { createStubBin } from './create-stub-bin';

/**
 * Creates a stand-in for the Claude CLI as `fake-claude` under the directory
 * and returns its path. It prints `UP:<pid>`, then reads one line at a time
 * and prints `GOT:<line>:<pid>` after each, so a test sees which process
 * took its input. A `quit` line ends it with exit code 3.
 */
export function createStubEchoClaude(dir: string): string {
  return createStubBin(
    dir,
    'fake-claude',
    `#!/usr/bin/env bash
echo "UP:$$"
while read -r line; do
  if [ "$line" = "quit" ]; then exit 3; fi
  echo "GOT:$line:$$"
done
`,
  );
}
