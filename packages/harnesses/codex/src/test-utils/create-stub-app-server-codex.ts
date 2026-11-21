import { join } from 'node:path';
import { writeStubProgram } from '@atc/core/test-utils/write-stub-program';

export function createStubAppServerCodex(directory: string): string {
  const server = join(import.meta.dir, 'run-stub-codex-app-server.ts');

  return writeStubProgram(
    directory,
    'fake-codex',
    `#!/usr/bin/env bash
if [ "$1" = app-server ]; then
  exec "${process.execPath}" "${server}" "${directory}" "$@"
fi
echo "FAKE_CODEX_UP args: $*"
exec tail -f /dev/null
`,
  );
}
