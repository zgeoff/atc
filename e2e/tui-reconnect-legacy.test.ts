import { expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readDaemonRecord } from '@atc/lifecycle';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { startStubLegacyDaemonProcess, startTUIHarness } from '@atc/test-utils';
import invariant from 'tiny-invariant';

// A client on an idle daemon whose socket a daemon on another protocol has
// taken, so the client's reconnect after the first daemon dies meets it.
async function setupTest() {
  const harness = startTUIHarness();
  const stateDir = join(harness.home, '.local', 'state', 'atc');
  const socketPath = join(harness.home, 'atc-daemon.sock');
  const pty = harness.boot();

  await harness.waitFor('idle');

  const first = readDaemonRecord(join(stateDir, 'daemon.json'));

  invariant(first !== null, 'the first daemon wrote no record');

  // The first daemon keeps its listener and the client's connection after
  // its socket file goes, so the other daemon can bind the path.
  unlinkSync(socketPath);

  const legacy = await startStubLegacyDaemonProcess(socketPath, stateDir);

  harness.reset();
  process.kill(first.pid, 'SIGKILL');

  return { harness, legacy, pty };
}

test('it restarts a daemon on another protocol that a reconnect meets after the user confirms', async () => {
  const ctx = await setupTest();

  await ctx.harness.waitFor('Restart it now?');

  expect(ctx.harness.read()).toInclude(`daemon atc/legacy-build speaks v${PROTOCOL_V + 1}`);

  ctx.harness.reset();
  ctx.harness.write('y');

  await ctx.legacy.exited;

  await ctx.harness.waitFor('idle');

  expect(ctx.legacy.signalCode).toBe('SIGTERM');
});

test('it draws the reconnect restart prompt again when the terminal resizes', async () => {
  const ctx = await setupTest();

  await ctx.harness.waitFor('Restart it now?');

  ctx.harness.reset();
  ctx.pty.resize(100, 30);

  await ctx.harness.waitFor('Restart it now?');

  ctx.harness.write('y');

  await ctx.legacy.exited;

  expect(ctx.legacy.signalCode).toBe('SIGTERM');
});

test('it quits when the user keeps a daemon on another protocol that a reconnect meets', async () => {
  const ctx = await setupTest();

  await ctx.harness.waitFor('Restart it now?');

  ctx.harness.reset();
  ctx.harness.write('n');

  const code = await ctx.harness.waitForExit();

  expect(code).toBe(1);
  expect(ctx.harness.read()).toInclude(`daemon atc/legacy-build speaks v${PROTOCOL_V + 1}`);
  expect(ctx.legacy.exitCode).toBeNull();
});
