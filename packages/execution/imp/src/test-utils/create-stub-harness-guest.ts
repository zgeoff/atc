import { join } from 'node:path';
import { writeStubProgram } from '@atc/core/test-utils/write-stub-program';
import { run } from '@zgeoff/testing/process';

// The burst of 300000 bytes is more than impd's ring keeps.
export async function createStubHarnessGuest(directory: string) {
  const burstPath = join(directory, 'burst');

  await run(['mkfifo', burstPath]);

  const path = writeStubProgram(
    directory,
    'harness',
    `#!/usr/bin/env bash
echo "UP:$$ START:$(stty size)"
while read -r line; do
  if [ "$line" = "later" ]; then
    (cat "${burstPath}" > /dev/null; head -c 300000 /dev/zero | tr '\\0' 'x'; echo; echo "BURST_DONE") &
  fi
  if [ "$line" = "size" ]; then echo "SIZE:$(stty size)"; fi
  if [ "$line" = "quit" ]; then exit 3; fi
  echo "GOT:$line"
done
`,
  );

  return { path, burstPath };
}
