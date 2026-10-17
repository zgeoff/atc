import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';

export function createStubAppServerCodex(dir: string): string {
  const server = join(import.meta.dir, 'run-stub-codex-app-server.ts');

  return createStubBin(
    dir,
    'fake-codex',
    `#!/usr/bin/env bash
if [ "$1" = app-server ]; then
  exec "${process.execPath}" "${server}" "${dir}" "$@"
fi
echo "FAKE_CODEX_UP args: $*"
exec tail -f /dev/null
`,
  );
}
