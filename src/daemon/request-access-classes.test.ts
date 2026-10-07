import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startDaemon } from './daemon';
import { REQUEST_ACCESS_CLASSES } from './request-access-classes';

const TOKEN = 'a'.repeat(32);

/**
 * A real daemon on a local socket and a loopback TCP listener, whose
 * config lists the principal `gw` for the target `local`. `owner` is the
 * daemon owner's connection on the local socket, `openPrincipal` opens a
 * local connection whose handshake gives `gw`, and `openTCP` opens a TCP
 * connection whose handshake carries the listener's token.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-request-access-');
  const tokenFile = join(tmp.dir, 'gateway-token');
  const socketPath = join(tmp.dir, 'daemon.sock');

  writeFileSync(tokenFile, `${TOKEN}\n`);

  const daemon = await startDaemon({
    socketPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
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
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    principals: new Map([['gw', ['local']]]),
    listen: { host: '127.0.0.1', port: 0, tokenFile },
    log: () => {},
  });

  const clients: DaemonClient[] = [];

  const owner = await DaemonClient.open(socketPath);

  clients.push(owner);

  await owner.sendHello('atc/test-build');

  return {
    owner,
    async openPrincipal(): Promise<DaemonClient> {
      const client = await DaemonClient.open(socketPath);

      clients.push(client);

      await client.sendRequest('daemon.hello', { client: 'atc/test-build', principal: 'gw' });

      return client;
    },
    async openTCP(): Promise<DaemonClient> {
      const client = await DaemonClient.open({
        hostname: '127.0.0.1',
        port: daemon.listenPort ?? 0,
      });

      clients.push(client);

      await client.sendHello('atc/test-gateway', TOKEN);

      return client;
    },
    async [Symbol.asyncDispose]() {
      for (const client of clients) {
        client.stop();
      }

      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}

test('it keeps the daemon-wide and credential methods, and only those, owner-only', () => {
  const owned = Object.entries(REQUEST_ACCESS_CLASSES)
    .filter(([, access]) => access === 'owner')
    .map(([method]) => method);

  expect(owned).toIncludeSameMembers([
    'daemon.quit',
    'fleet.restore',
    'session.auth.revoke',
    'session.auth.rebind',
  ]);
});

test.each(
  Object.entries(REQUEST_ACCESS_CLASSES)
    .filter(([, access]) => access === 'owner')
    .map(([method]) => [method]),
)('it refuses %s from a principal connection as owner-only', async (method) => {
  await using daemon = await setupTest();

  const client = await daemon.openPrincipal();

  expect(client.sendRequest(method, {})).rejects.toMatchObject({
    code: 'unauthorized',
    message: `${method} is open to the daemon's owner only`,
  });

  const pinged = await daemon.owner.sendRequest('daemon.ping', {});

  expect(pinged).toStrictEqual({});
});

test.each(
  Object.entries(REQUEST_ACCESS_CLASSES)
    .filter(([, access]) => access === 'owner')
    .map(([method]) => [method]),
)('it refuses %s from the owner acting as a principal as owner-only', async (method) => {
  await using daemon = await setupTest();

  expect(daemon.owner.sendRequest(method, {}, 'gw')).rejects.toMatchObject({
    code: 'unauthorized',
    message: `${method} is open to the daemon's owner only`,
  });

  const pinged = await daemon.owner.sendRequest('daemon.ping', {});

  expect(pinged).toStrictEqual({});
});

test.each(
  Object.entries(REQUEST_ACCESS_CLASSES)
    .filter(([, access]) => access === 'owner')
    .map(([method]) => [method]),
)('it refuses %s over TCP as owner-only', async (method) => {
  await using daemon = await setupTest();

  const client = await daemon.openTCP();

  expect(client.sendRequest(method, {}, 'gw')).rejects.toMatchObject({
    code: 'unauthorized',
    message: `${method} is open to the daemon's owner only`,
  });

  const pinged = await daemon.owner.sendRequest('daemon.ping', {});

  expect(pinged).toStrictEqual({});
});

// The owner's quit stops the daemon under the test, so the daemon e2e suite
// covers it instead.
test.each(
  Object.entries(REQUEST_ACCESS_CLASSES)
    .filter(([method, access]) => access === 'owner' && method !== 'daemon.quit')
    .map(([method]) => [method]),
)('it admits %s from the owner', async (method) => {
  await using daemon = await setupTest();

  const answer = await daemon.owner.sendRequest(method, {}).catch((error: unknown) => error);

  expect(answer).not.toMatchObject({ code: 'unauthorized' });
});

// The handshake has rules of its own and is answered before admission, so
// the rows leave it out.
test.each(
  Object.entries(REQUEST_ACCESS_CLASSES)
    .filter(([method, access]) => access === 'principal' && method !== 'daemon.hello')
    .map(([method]) => [method]),
)('it admits %s from a principal connection', async (method) => {
  await using daemon = await setupTest();

  const client = await daemon.openPrincipal();
  const answer = await client.sendRequest(method, {}).catch((error: unknown) => error);

  expect(answer).not.toMatchObject({ code: 'unauthorized' });
});

test.each(
  Object.entries(REQUEST_ACCESS_CLASSES)
    .filter(([method, access]) => access === 'principal' && method !== 'daemon.hello')
    .map(([method]) => [method]),
)('it admits %s over TCP from a principal', async (method) => {
  await using daemon = await setupTest();

  const client = await daemon.openTCP();
  const answer = await client.sendRequest(method, {}, 'gw').catch((error: unknown) => error);

  expect(answer).not.toMatchObject({ code: 'unauthorized' });
});

test('it answers a method the protocol does not define from a principal as unknown', async () => {
  await using daemon = await setupTest();

  const client = await daemon.openPrincipal();

  expect(client.sendRequest('daemon.nuke', {})).rejects.toMatchObject({
    code: 'unknown_method',
    message: "unknown method 'daemon.nuke'",
  });
});
