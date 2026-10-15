import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';

/**
 * Creates a stand-in Codex CLI for sessions that run on a Codex App Server,
 * as `fake-codex` under the directory, and returns its path. Started as
 * `app-server --listen unix://<path>`, it runs the stand-in App Server,
 * which reads its scenario from and writes its request log to the
 * directory. Started any other way, as the terminal is, it prints
 * `FAKE_CODEX_UP args: ` with its arguments and waits until it is stopped.
 */
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
