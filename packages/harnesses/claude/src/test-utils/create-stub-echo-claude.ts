import { writeStubProgram } from '@atc/core/test-utils/write-stub-program';

export function createStubEchoClaude(directory: string): string {
  return writeStubProgram(
    directory,
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
