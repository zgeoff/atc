import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { CONTRACT_MAJOR } from '@atcx/contract/light';
import invariant from 'tiny-invariant';
import { openRawDaemonClient as openDaemonClient } from './open-raw-daemon-client';
import { startStubLegacyDaemon } from './start-stub-legacy-daemon';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-legacy-');

  return { socketPath: join(temporaryDirectory.path, 'daemon.sock') };
}

test('it drops a connection on the selected request after answering the handshake', async () => {
  const ctx = setupTest();
  const daemon = startStubLegacyDaemon(ctx.socketPath, { closeOnRequest: 'session.list' });

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  expect(client.sendRequest('session.list')).rejects.toThrowWithMessage(Error, 'connection closed');

  expect(daemon.requests).toStrictEqual([
    {
      method: 'daemon.hello',
      params: {
        client: 'atc/test-build',
        protocol: 15,
        major: CONTRACT_MAJOR,
        auth: { scheme: 'none' },
      },
    },
    { method: 'session.list', params: {} },
  ]);
});

test('it answers the handshake with its build', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(ctx.socketPath);

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  const hello = await client.sendHello('atc/test-build');

  expect(hello).toStrictEqual({
    daemon: 'atc/legacy-build',
    daemonID: 'd-legacy',
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    idempotency: { completedRetentionMs: 60_000 },
    lastUsedAgent: 'claude',
    peerSession: null,
  });
});

test('it answers a method with the reply it was given and records the request', async () => {
  const ctx = setupTest();

  const daemon = startStubLegacyDaemon(ctx.socketPath, {
    replies: { 'message.get': { message: 'm-1', status: 'queued' } },
  });

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  const got = await client.sendRequest('message.get', { message: 'm-1', waitMs: 5000 });

  expect(got).toStrictEqual({ message: 'm-1', status: 'queued' });

  expect(daemon.requests).toStrictEqual([
    {
      method: 'daemon.hello',
      params: {
        client: 'atc/test-build',
        protocol: 15,
        major: CONTRACT_MAJOR,
        auth: { scheme: 'none' },
      },
    },
    { method: 'message.get', params: { message: 'm-1', waitMs: 5000 } },
  ]);
});

test('it refuses a method it was given no reply for', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(ctx.socketPath);

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  expect(client.sendRequest('agents.list')).rejects.toMatchObject({
    code: 'unknown_method',
  });
});

test('it answers a ping without being given a reply', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(ctx.socketPath);

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  const pong = await client.sendRequest('daemon.ping');

  expect(pong).toStrictEqual({});
});

test('it refuses a hello on another protocol version with protocol_mismatch', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(ctx.socketPath, { protocol: 3 });

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test-build')).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message:
      'atc/test-build speaks protocol v15, daemon atc/legacy-build speaks v3; restart the daemon so both run the same build',
    data: {},
  });
});

test('it puts its protocol version in the refusal data when told to', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(ctx.socketPath, { protocol: 3, refusalHoldsProtocol: true });

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test-build')).rejects.toMatchObject({
    code: 'protocol_mismatch',
    data: { daemonProtocol: 3 },
  });
});

test('it counts a connection it accepted as open until the client closes it', async () => {
  const ctx = setupTest();
  const daemon = startStubLegacyDaemon(ctx.socketPath);

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  expect(daemon.connections).toStrictEqual({ accepted: 1, open: 1 });
});

test('it counts a connection the client closed as accepted and no longer open', async () => {
  const ctx = setupTest();
  const daemon = startStubLegacyDaemon(ctx.socketPath);

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  client.stop();

  await waitFor(() => {
    expect(daemon.connections).toStrictEqual({ accepted: 1, open: 0 });
  });
});

test('it stops listening when stopped', () => {
  const ctx = setupTest();
  const legacy = startStubLegacyDaemon(ctx.socketPath);

  legacy.stop();

  expect(openDaemonClient(ctx.socketPath)).rejects.toThrow();
});

test('it answers the handshake on the TCP port it bound when given a TCP address', async () => {
  const daemon = startStubLegacyDaemon({ hostname: '127.0.0.1', port: 0 });

  invariant(daemon.port !== null, 'the daemon bound no TCP port');

  const client = await openDaemonClient({ hostname: '127.0.0.1', port: daemon.port });

  registerTestCleanup(() => {
    client.stop();
  });

  const hello = await client.sendHello('atc/test-build');

  expect(hello).toStrictEqual({
    daemon: 'atc/legacy-build',
    daemonID: 'd-legacy',
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    idempotency: { completedRetentionMs: 60_000 },
    lastUsedAgent: 'claude',
    peerSession: null,
  });
});

test('it holds no port when it listens on a unix socket', () => {
  const ctx = setupTest();
  const daemon = startStubLegacyDaemon(ctx.socketPath);

  expect(daemon.port).toBeNull();
});

test('it stops listening once the test finishes without a stop', () => {
  const path = join(tmpdir(), `atc-stub-legacy-${randomUUID()}.sock`);
  let left: boolean | null = null;

  registerTestCleanup(() => {
    left = existsSync(path);

    rmSync(path, { force: true });
  });

  startStubLegacyDaemon(path);

  onTestFinished(() => {
    expect(left).toBeFalse();
  });
});

test('it leaves a daemon its caller owns listening once the test finishes', () => {
  const path = join(tmpdir(), `atc-stub-legacy-${randomUUID()}.sock`);
  const daemon = startStubLegacyDaemon(path, { owner: 'caller' });

  onTestFinished(() => {
    expect(existsSync(path)).toBeTrue();
  });

  onTestFinished(() => {
    daemon.stop();

    rmSync(path, { force: true });
  });
});

test('it refuses a method with the error it was given', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(ctx.socketPath, {
    refusals: { 'session.input': { code: 'unauthorized', message: 'input refused' } },
  });

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  expect(
    client.sendRequest('session.input', { session: 's1', data: 'x' }),
  ).rejects.toThrowWithMessage(Error, 'input refused');
});
