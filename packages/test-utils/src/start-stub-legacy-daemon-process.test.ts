import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDaemonStatePaths } from '@atc/config';
import { openDaemonClient } from '@atcx/contract/client';
import { PROTOCOL_VERSION } from '@atcx/contract/light';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubLegacyDaemonProcess } from './start-stub-legacy-daemon-process';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-legacy-process-');

  return {
    directory: temporaryDirectory.path,
    socketPath: join(temporaryDirectory.path, 'daemon.sock'),
  };
}

test('it resolves once the daemon has recorded its own pid', async () => {
  const ctx = setupTest();

  const daemon = await startStubLegacyDaemonProcess(ctx.socketPath, ctx.directory);

  const record: unknown = JSON.parse(
    readFileSync(buildDaemonStatePaths(ctx.directory).recordFile, 'utf8'),
  );

  expect(record).toMatchObject({ pid: daemon.pid, socketPath: ctx.socketPath });
});

test('it starts a daemon on the protocol after the current one', async () => {
  const ctx = setupTest();

  await startStubLegacyDaemonProcess(ctx.socketPath, ctx.directory);

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test-build')).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message: `atc/test-build speaks protocol v${PROTOCOL_VERSION}, daemon atc/legacy-build speaks v${PROTOCOL_VERSION + 1}; restart the daemon so both run the same build`,
  });
});

test('it starts a daemon on the next protocol that puts its version in its refusal data when told to', async () => {
  const ctx = setupTest();

  await startStubLegacyDaemonProcess(ctx.socketPath, ctx.directory, 'newer');

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test-build')).rejects.toMatchObject({
    code: 'protocol_mismatch',
    data: { daemonProtocol: PROTOCOL_VERSION + 1 },
  });
});
