import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './run-command';

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

// A native program keeps its DYLD_ variables on macOS, where a script loses
// them on the way into its protected interpreter.
export async function createStubNativeClaude(directory: string, name: string): Promise<string> {
  const cc = Bun.which('cc');

  if (cc === null) {
    throw new Error('the native stand-in needs cc on the PATH');
  }

  mkdirSync(directory, { recursive: true });

  const source = join(directory, `${name}.c`);
  const path = join(directory, name);

  writeFileSync(source, NATIVE_SOURCE);

  const build = await runCommand([cc, '-o', path, source]);

  if (build.exitCode !== 0) {
    throw new Error(`cc failed to build the native stand-in: ${build.stderr}`);
  }

  return path;
}
