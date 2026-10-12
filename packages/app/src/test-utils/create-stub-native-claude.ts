import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './run-command';

/**
 * Creates a stand-in for the Claude CLI as a native program under the
 * directory, which it creates when missing, and returns the program's path.
 * It prints `FAKE_NATIVE_DYLD:[<value>]` with the `DYLD_ATC_TEST` value it
 * started with, or `unset`, then reads its input until the input closes.
 *
 * A native program that no system protection covers keeps its `DYLD_`
 * variables on macOS, where a script loses them on the way into its
 * protected interpreter. The system C compiler builds it, so the test host
 * needs `cc` on its PATH. Call it only inside a test.
 */
export async function createStubNativeClaude(dir: string, name: string): Promise<string> {
  const cc = Bun.which('cc');

  if (cc === null) {
    throw new Error('the native stand-in needs cc on the PATH');
  }

  mkdirSync(dir, { recursive: true });

  const source = join(dir, `${name}.c`);
  const path = join(dir, name);

  writeFileSync(source, NATIVE_SOURCE);

  const build = await runCommand([cc, '-o', path, source]);

  if (build.exitCode !== 0) {
    throw new Error(`cc failed to build the native stand-in: ${build.stderr}`);
  }

  return path;
}

const NATIVE_SOURCE = `#include <stdio.h>
#include <stdlib.h>

int main(void) {
  const char *value = getenv("DYLD_ATC_TEST");
  printf("FAKE_NATIVE_DYLD:[%s]\\n", value == NULL ? "unset" : value);
  fflush(stdout);
  while (getchar() != EOF) {
  }
  return 0;
}
`;
