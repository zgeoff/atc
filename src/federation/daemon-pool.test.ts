import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockRegistryDaemon } from '../test-utils/build-mock-registry-daemon';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { DaemonPool } from './daemon-pool';

/**
 * Two real daemons, `cloud` and `pc`, each with a TCP listener on a
 * loopback port that takes one fixed token, and `cloudID` and `pcID`, the
 * state identity each one's handshake returns.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-daemon-pool-'));

  // The token both listeners take, which every pool here presents.
  writeFileSync(join(tmp.dir, 'token'), `${'a'.repeat(32)}\n`);

  const cloud = await startTestDaemon({
    prefix: 'atc-daemon-pool-cloud-',
    options: () => ({
      adapter: buildMockAgentAdapter(),

      // Lets the pool's principal use the local target.
      principals: new Map([['gw', ['local']]]),
      listen: { host: '127.0.0.1', port: 0, tokenFile: join(tmp.dir, 'token') },
    }),
  });

  stack.use(cloud);

  const pc = await startTestDaemon({
    prefix: 'atc-daemon-pool-pc-',
    options: () => ({
      adapter: buildMockAgentAdapter(),

      // Lets the pool's principal use the local target.
      principals: new Map([['gw', ['local']]]),
      listen: { host: '127.0.0.1', port: 0, tokenFile: join(tmp.dir, 'token') },
    }),
  });

  stack.use(pc);

  const cloudProber = await DaemonClient.open(cloud.socketPath);

  stack.defer(() => {
    cloudProber.stop();
  });

  const pcProber = await DaemonClient.open(pc.socketPath);

  stack.defer(() => {
    pcProber.stop();
  });

  const cloudHello = await cloudProber.sendHello(cloud.build);
  const pcHello = await pcProber.sendHello(pc.build);

  const owned = stack.move();

  return {
    cloud,
    pc,
    cloudID: String(cloudHello['daemonID']),
    pcID: String(pcHello['daemonID']),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it gives each registry daemon its own caller that reaches only that daemon', async () => {
  await using ctx = await setupTest();

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

  const pool = new DaemonPool({
    registry: {
      daemons: new Map([
        ['cloud', cloud],
        ['pc', pc],
      ]),
      defaultDaemon: 'cloud',
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => pool.stop());

  await ctx.cloud.client.sendRequest('session.spawn', {
    cwd: ctx.cloud.dir,
    name: 'on-cloud',
    cols: 80,
    rows: 24,
  });

  const listed = await Promise.all([
    pool.getCaller('cloud').sendRequest('session.list', {}, 'gw'),
    pool.getCaller('pc').sendRequest('session.list', {}, 'gw'),
  ]);

  expect(listed).toStrictEqual([
    { sessions: [expect.objectContaining({ name: 'on-cloud' })] },
    { sessions: [] },
  ]);
});

test('it refuses a caller for a name the registry does not hold', () => {
  const pool = new DaemonPool({
    registry: { daemons: new Map(), defaultDaemon: 'cloud' },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  expect(() => pool.getCaller('pc')).toThrowWithMessage(Error, "no daemon 'pc' in the registry");
});
