import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { startTUIHarness, waitFor } from '@atc/test-utils';
import { startTUIDaemon } from './start-tui-daemon';

// A harness home with its config written and no client booted.
function setupTest() {
  return { tui: startTUIHarness() };
}

test('it boots the client against the daemon in the test process and starts no daemon process', async () => {
  const ctx = setupTest();

  await startTUIDaemon(ctx.tui);

  ctx.tui.boot();

  await ctx.tui.waitFor('atc — control tower');

  expect(existsSync(join(ctx.tui.home, 'atc-daemon.pid'))).toBeFalse();
});

test('it stops its daemon once the test finishes', async () => {
  const ctx = setupTest();

  await startTUIDaemon(ctx.tui);

  const client = await openDaemonClient(join(ctx.tui.home, 'atc-daemon.sock'));

  await client.sendHello('atc/test');

  // Registered after the helper's cleanup, so it runs once the daemon stops;
  // an open connection outlives the harness removing the home's socket file.
  onTestFinished(async () => {
    await waitFor(
      () => {
        expect(client.isClosed()).toBeTrue();
      },
      { timeoutMs: 2000 },
    );
  });

  onTestFinished(() => {
    client.stop();
  });
});

test('it serves at the home socket and gives sessions the harness HOME, where the stand-in agent reads its scenario', async () => {
  const ctx = setupTest();

  await startTUIDaemon(ctx.tui);

  expect(existsSync(join(ctx.tui.home, 'atc-daemon.sock'))).toBeTrue();
  expect(process.env['HOME']).toBe(ctx.tui.home);
});
