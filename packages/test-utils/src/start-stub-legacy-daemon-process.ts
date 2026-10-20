import { join } from 'node:path';
import { registerTestCleanup } from './register-test-cleanup';

// Runs the legacy daemon in a process of its own, which a client can signal
// by the pid it records, and resolves once it listens; with 'line' it speaks
// an older release's line protocol, and the test's cleanup kills it.
export async function startStubLegacyDaemonProcess(
  socketPath: string,
  stateDir: string,
  build?: 'line',
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
