import { join } from 'node:path';

/**
 * Starts a daemon composed with a fixture source, in a process of its own
 * with the environment given, and resolves once it listens. Its home, sockets
 * and state follow that environment as `atc daemon`'s would, so a client
 * started with the same environment dials it instead of starting its own.
 * `ATC_TEST_SOURCES` picks its sources, the fixture one unless it holds
 * `none`; `ATC_TEST_FIXTURE_URL` holds the repository the fixture source
 * lists, and `ATC_TEST_SOURCE_LOG` a file it appends each listing to.
 * Disposal stops the process; hold the result with `await using`.
 */
export async function startStubSourceDaemon(env: Readonly<Record<string, string | undefined>>) {
  const daemon = Bun.spawn([process.execPath, join(import.meta.dir, 'run-source-daemon.ts')], {
    env: { ATC_TEST_SOURCES: 'fixture', ...env },
    stdout: 'pipe',
    stderr: 'ignore',
  });

  const stop = async () => {
    daemon.kill();

    await daemon.exited;
  };

  const reader = daemon.stdout.getReader();

  const first = await reader.read();

  reader.releaseLock();

  if (first.done) {
    await stop();

    throw new Error('the source daemon exited before it listened');
  }

  return { pid: daemon.pid, [Symbol.asyncDispose]: stop };
}
