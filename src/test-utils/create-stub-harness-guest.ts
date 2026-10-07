import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';

/**
 * Creates a stand-in guest program for a harness to run, under the
 * directory: a script that prints its pid and the terminal size it started
 * at as `UP:<pid> START:<rows> <cols>`, echoes each line it reads as
 * `GOT:<line>`, prints `SIZE:<rows> <cols>` on `size`, and exits 3 on
 * `quit`. On `later` it waits for a line on the named pipe at `burstPath`,
 * then prints 300000 `x` bytes, more than impd's ring keeps, a newline, and
 * `BURST_DONE`. Returns the script's path and the pipe's.
 */
export function createStubHarnessGuest(dir: string) {
  const burstPath = join(dir, 'burst');

  Bun.spawnSync(['mkfifo', burstPath]);

  const path = createStubBin(
    dir,
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
