import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { startDaemon } from '../daemon/daemon';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { DaemonPool } from './daemon-pool';

/**
 * Two real daemons with TCP listeners on loopback ports, each on its own
 * state and token. `cloud` and `pc` hold each daemon's port, token, and
 * the state identity its handshake returns.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-daemon-pool-');

  const started: {
    readonly daemon: Awaited<ReturnType<typeof startDaemon>>;
    readonly port: number;
    readonly token: string;
    readonly daemonID: string;
  }[] = [];

  for (const name of ['cloud', 'pc']) {
    const tokenFile = join(tmp.dir, `${name}-token`);
    const token = name.repeat(32);

    writeFileSync(tokenFile, `${token}\n`);
    mkdirSync(join(tmp.dir, name));

    const daemon = await startDaemon({
      socketPath: join(tmp.dir, `${name}.sock`),
      reporterSocketPath: join(tmp.dir, `${name}-reporter.sock`),
      build: `atc/${name}`,
      adapter: {
        id: 'claude',
        screenDetector: null,
        takesMessages: true,
        headlessRunner: null,
        planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
        normalizeHook: () => ({ kind: 'prompt-submitted' }),
        loadName: () => Promise.resolve(null),
        canResume: () => true,
        buildResumeCommand: () => 'claude --resume',
      },
      dbPath: join(tmp.dir, name, 'state.db'),
      statusPath: join(tmp.dir, `${name}-status.json`),
      principals: new Map([['gw', ['local']]]),
      listen: { host: '127.0.0.1', port: 0, tokenFile },
    });

    const owner = await DaemonClient.open(join(tmp.dir, `${name}.sock`));
    const hello = await owner.sendHello('atc/test-build');

    owner.stop();

    started.push({
      daemon,
      port: daemon.listenPort ?? 0,
      token,
      daemonID: String(hello['daemonID']),
    });
  }

  const [cloud, pc] = started;

  if (cloud === undefined || pc === undefined) {
    throw new Error('a daemon did not start');
  }

  return {
    cloud,
    pc,
    async [Symbol.asyncDispose]() {
      for (const entry of started) {
        await entry.daemon.stop();
      }

      tmp[Symbol.dispose]();
    },
  };
}

test('it gives each registry daemon its own caller that reaches only that daemon', async () => {
  await using daemons = await setupTest();

  const pool = new DaemonPool({
    registry: {
      daemons: new Map([
        [
          'cloud',
          {
            name: 'cloud',
            address: { host: '127.0.0.1', port: daemons.cloud.port },
            daemonID: daemons.cloud.daemonID,
            incarnation: daemons.cloud.daemonID.slice(0, 8),
            token: daemons.cloud.token,
          },
        ],
        [
          'pc',
          {
            name: 'pc',
            address: { host: '127.0.0.1', port: daemons.pc.port },
            daemonID: daemons.pc.daemonID,
            incarnation: daemons.pc.daemonID.slice(0, 8),
            token: daemons.pc.token,
          },
        ],
      ]),
      defaultDaemon: 'cloud',
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  const cloudHello = await pool.getCaller('cloud').readHello();
  const pcHello = await pool.getCaller('pc').readHello();

  await pool.stop();

  expect([cloudHello.build, pcHello.build]).toStrictEqual(['atc/cloud', 'atc/pc']);

  expect([cloudHello.daemonID, pcHello.daemonID]).toStrictEqual([
    daemons.cloud.daemonID,
    daemons.pc.daemonID,
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
