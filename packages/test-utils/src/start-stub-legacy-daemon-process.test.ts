import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubLegacyDaemonProcess } from './start-stub-legacy-daemon-process';

function setupTest() {
  const tmp = setupTempDir('atc-legacy-process-');

  return { dir: tmp.dir, socketPath: join(tmp.dir, 'daemon.sock') };
}

test('it resolves once the daemon has recorded its own pid', async () => {
  const ctx = setupTest();

  const daemon = await startStubLegacyDaemonProcess(ctx.socketPath, ctx.dir);

  const record: unknown = JSON.parse(readFileSync(join(ctx.dir, 'daemon.json'), 'utf8'));

  expect(record).toMatchObject({ pid: daemon.pid, socketPath: ctx.socketPath });
});

test('it starts a daemon on the protocol after the current one', async () => {
  const ctx = setupTest();

  await startStubLegacyDaemonProcess(ctx.socketPath, ctx.dir);

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test-build')).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message: `atc/test-build speaks protocol v${PROTOCOL_V}, daemon atc/legacy-build speaks v${PROTOCOL_V + 1}; restart the daemon so both run the same build`,
  });
});

test('it starts a daemon on the line protocol when told to speak it', async () => {
  const ctx = setupTest();

  await startStubLegacyDaemonProcess(ctx.socketPath, ctx.dir, 'line');

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test-build')).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message: 'the daemon speaks an older protocol; restart the daemon so both run the same build',
  });
});
