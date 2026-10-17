import { createStubBin } from './create-stub-bin';

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
