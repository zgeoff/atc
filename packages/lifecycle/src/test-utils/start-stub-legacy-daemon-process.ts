import { join } from 'node:path';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';

export async function startStubLegacyDaemonProcess(
  socketPath: string,
  stateDir: string,
  build?: 'newer',
) {
  const daemon = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'run-stub-legacy-daemon.ts'),
      socketPath,
      stateDir,
      ...(build === undefined ? [] : [build]),
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  );

  registerTestCleanup(() => {
    daemon.kill('SIGKILL');
  });

  const reader = daemon.stdout.getReader();

  await reader.read();

  reader.releaseLock();

  return daemon;
}
