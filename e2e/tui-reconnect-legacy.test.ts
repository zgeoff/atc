import { expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { startTUIHarness } from '@atc/app/test-utils/start-tui-harness';
import { readDaemonRecord } from '@atc/lifecycle';
import { startStubLegacyDaemonProcess } from '@atc/lifecycle/test-utils/start-stub-legacy-daemon-process';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import invariant from 'tiny-invariant';

async function setupTest() {
  const harness = startTUIHarness({ createStateDB: createMigratedStateDB });
  const stateDir = harness.paths.stateDir;
  const socketPath = harness.paths.daemonSocketPath;
  const pty = harness.boot();

  await harness.waitFor('n  new');

  const first = readDaemonRecord(harness.paths.daemonRecordFile);

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

  await ctx.harness.waitFor('n new');

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
