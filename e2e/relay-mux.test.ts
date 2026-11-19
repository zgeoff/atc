import { expect, onTestFinished, test } from 'bun:test';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { resolveATCCommand } from '@atc/core/test-utils/resolve-atc-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';

function setupTest() {
  const directory = setupTempDir('atc-e2e-relay-mux-');
  const socketPath = join(directory.path, 'bridge.sock');

  const mux = Bun.spawn([...resolveATCCommand(), 'relay-mux', socketPath], {
    env: { ...process.env, HOME: directory.path, XDG_RUNTIME_DIR: directory.path },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  onTestFinished(() => {
    mux.kill();
  });

  const reporterConnects = async () => {
    await waitFor(
      () =>
        new Promise<void>((resolve, reject) => {
          const socket = connect(socketPath);

          socket.on('error', reject);

          socket.on('connect', () => {
            socket.destroy();

            resolve();
          });
        }),
    );
  };

  return { mux, reporterConnects };
}

test('it binds the bridge socket before it reads stdin', async () => {
  const ctx = setupTest();

  await expect(ctx.reporterConnects()).toResolve();
});

test('it keeps serving the bridge socket after its stdin closes', async () => {
  const ctx = setupTest();

  await ctx.reporterConnects();
  await ctx.mux.stdin.end();

  await setImmediate();

  expect(ctx.mux.exitCode).toBeNull();

  await expect(ctx.reporterConnects()).toResolve();
});
