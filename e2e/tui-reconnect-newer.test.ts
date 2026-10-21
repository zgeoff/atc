import { expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readDaemonRecord } from '@atc/lifecycle';
import { startStubLegacyDaemonProcess, startTUIHarness } from '@atc/test-utils';
import invariant from 'tiny-invariant';

test('it tells the user to reopen a client that a reconnect finds older than the daemon, and never offers a restart', async () => {
  const harness = startTUIHarness();
  const stateDir = join(harness.home, '.local', 'state', 'atc');
  const socketPath = join(harness.home, 'atc-daemon.sock');

  harness.boot();

  await harness.waitFor('idle');

  const first = readDaemonRecord(join(stateDir, 'daemon.json'));

  invariant(first !== null, 'the first daemon wrote no record');

  // The first daemon keeps its listener and the client's connection after
  // its socket file goes, so the newer daemon can bind the path.
  unlinkSync(socketPath);

  const newer = await startStubLegacyDaemonProcess(socketPath, stateDir, 'newer');

  harness.reset();
  process.kill(first.pid, 'SIGKILL');

  const code = await harness.waitForExit();

  expect(code).toBe(1);
  expect(harness.read()).toInclude('is older than the atc daemon');
  expect(harness.read()).not.toInclude('Restart it now?');
  expect(newer.exitCode).toBeNull();
});
