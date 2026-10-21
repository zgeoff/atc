import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestDaemon } from '@atc/daemon/testing';
import { openDaemonClient } from '@atc/protocol/client';
import { buildMockAgentAdapter, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { createDaemonPool } from './create-daemon-pool';
import { buildMockRegistryDaemon } from './testing/build-mock-registry-daemon';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-daemon-pool-');

  // The token both listeners take, which every pool here presents.
  writeFileSync(join(temporaryDirectory.path, 'token'), `${'a'.repeat(32)}\n`);

  const cloud = await startTestDaemon({
    prefix: 'atc-daemon-pool-cloud-',
    options: () => ({
      adapter: buildMockAgentAdapter(),

      // Lets the pool's principal use the local target.
      principals: new Map([['gw', ['local']]]),
      listen: { host: '127.0.0.1', port: 0, tokenFile: join(temporaryDirectory.path, 'token') },
    }),
  });

  const pc = await startTestDaemon({
    prefix: 'atc-daemon-pool-pc-',
    options: () => ({
      adapter: buildMockAgentAdapter(),

      // Lets the pool's principal use the local target.
      principals: new Map([['gw', ['local']]]),
      listen: { host: '127.0.0.1', port: 0, tokenFile: join(temporaryDirectory.path, 'token') },
    }),
  });

  const cloudProber = await openDaemonClient(cloud.socketPath);

  registerTestCleanup(() => {
    cloudProber.stop();
  });

  const pcProber = await openDaemonClient(pc.socketPath);

  registerTestCleanup(() => {
    pcProber.stop();
  });

  const cloudHello = await cloudProber.sendHello(cloud.build);
  const pcHello = await pcProber.sendHello(pc.build);

  return {
    cloud,
    pc,
    cloudID: String(cloudHello['daemonID']),
    pcID: String(pcHello['daemonID']),
  };
}

test('it gives each registry daemon its own caller that reaches only that daemon', async () => {
  const ctx = await setupTest();

  const cloud = buildMockRegistryDaemon({
    name: 'cloud',
    address: { host: '127.0.0.1', port: Number(ctx.cloud.daemon.listenPort) },
    daemonID: ctx.cloudID,
    token: 'a'.repeat(32),
  });

  const pc = buildMockRegistryDaemon({
    name: 'pc',
    address: { host: '127.0.0.1', port: Number(ctx.pc.daemon.listenPort) },
    daemonID: ctx.pcID,
    token: 'a'.repeat(32),
  });

  const pool = createDaemonPool({
    registry: {
      daemons: new Map([
        ['cloud', cloud],
        ['pc', pc],
      ]),
      defaultDaemon: 'cloud',
    },
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => pool.stop());

  await ctx.cloud.client.sendRequest('session.spawn', {
    cwd: ctx.cloud.directory,
    name: 'on-cloud',
    cols: 80,
    rows: 24,
  });

  const [onCloud, onPC] = await Promise.all([
    pool.getCaller('cloud').sendRequest('session.list', {}, { id: 'gw', name: 'Lantern Notes' }),
    pool.getCaller('pc').sendRequest('session.list', {}, { id: 'gw', name: 'Lantern Notes' }),
  ]);

  expect(onCloud).toStrictEqual({ sessions: [expect.objectContaining({ name: 'on-cloud' })] });
  expect(onPC).toStrictEqual({ sessions: [] });
});

test('it refuses a caller for a name the registry does not hold', () => {
  const pool = createDaemonPool({
    registry: { daemons: new Map(), defaultDaemon: 'cloud' },
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  expect(() => pool.getCaller('pc')).toThrowWithMessage(Error, "no daemon 'pc' in the registry");
});
