import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import { openRawDaemonClient as openDaemonClient } from './open-raw-daemon-client';
import { startStubDroppingDaemon } from './start-stub-dropping-daemon';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-dropping-daemon-');

  return { socketPath: join(temporaryDirectory.path, 'daemon.sock') };
}

test('it answers the handshake with its build', async () => {
  const ctx = setupTest();

  startStubDroppingDaemon(ctx.socketPath);

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test-build')).resolves.toStrictEqual({
    daemon: 'atc/dropping-build',
    daemonID: 'd-stub',
    features: [],
    idempotency: { completedRetentionMs: 60_000 },
    peerSession: null,
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    lastUsedAgent: 'claude',
  });
});

test('it drops the connection of the first request without answering it', async () => {
  const ctx = setupTest();

  startStubDroppingDaemon(ctx.socketPath);

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  expect(client.sendRequest('session.spawn', { idempotencyKey: 'k-1' })).rejects.toMatchObject({
    code: 'internal',
    message: 'connection closed',
  });
});

test('it answers a later request with a session and records each request key', async () => {
  const ctx = setupTest();
  const daemon = startStubDroppingDaemon(ctx.socketPath);

  const first = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    first.stop();
  });

  await first.sendHello('atc/test-build');
  await first.sendRequest('session.spawn', { idempotencyKey: 'k-1' }).catch(() => null);

  const second = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    second.stop();
  });

  await second.sendHello('atc/test-build');

  const answered = await second.sendRequest('session.spawn', {});

  expect(answered).toStrictEqual({ session: { id: 's-1' } });
  expect(daemon.keys).toStrictEqual(['k-1', undefined]);
});

test('it records the params of each request as they arrived', async () => {
  const ctx = setupTest();
  const daemon = startStubDroppingDaemon(ctx.socketPath);

  const first = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    first.stop();
  });

  await first.sendHello('atc/test-build');

  await first
    .sendRequest('session.spawn', { cwd: '/srv/harbor', idempotencyKey: 'k-1' })
    .catch(() => null);

  const second = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    second.stop();
  });

  await second.sendHello('atc/test-build');
  await second.sendRequest('session.list');

  expect(daemon.params).toStrictEqual([{ cwd: '/srv/harbor', idempotencyKey: 'k-1' }, {}]);
});

test('it records the principal each request acts as', async () => {
  const ctx = setupTest();
  const daemon = startStubDroppingDaemon(ctx.socketPath);

  const first = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    first.stop();
  });

  await first.sendHello('atc/test-build');
  await first.sendRequest('session.list', undefined, 'web-panel', 'Web panel').catch(() => null);

  const second = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    second.stop();
  });

  await second.sendHello('atc/test-build');
  await second.sendRequest('session.list');

  expect(daemon.principals).toStrictEqual(['web-panel', undefined]);
});

test('it stops listening when stopped', () => {
  const ctx = setupTest();
  const daemon = startStubDroppingDaemon(ctx.socketPath);

  daemon.stop();

  expect(openDaemonClient(ctx.socketPath)).rejects.toThrow();
});

test('it counts each read it takes from a connection', async () => {
  const ctx = setupTest();
  const daemon = startStubDroppingDaemon(ctx.socketPath);

  const raw = await Bun.connect({ unix: ctx.socketPath, socket: { data() {} } });

  registerTestCleanup(() => {
    raw.end();
  });

  raw.write('{"i":"1",');

  await waitFor(() => {
    expect(daemon.reads).toBe(1);
  });
});

test('it reads a request split across two writes as one request', async () => {
  const ctx = setupTest();
  const daemon = startStubDroppingDaemon(ctx.socketPath);
  const closed = Promise.withResolvers<void>();

  const raw = await Bun.connect({
    unix: ctx.socketPath,
    socket: {
      data() {},
      close() {
        closed.resolve();
      },
    },
  });

  registerTestCleanup(() => {
    raw.end();
  });

  raw.write('{"i":"1","p":{"u":"/session/spawn",');

  await waitFor(() => {
    expect(daemon.reads).toBe(1);
  });

  raw.write('"b":{"json":{"idempotencyKey":"k-split"}}}}\n');

  await closed.promise;

  expect(daemon.keys).toStrictEqual(['k-split']);
});

test('it stops listening once the test finishes without a stop', () => {
  const path = join(tmpdir(), `atc-stub-dropping-${randomUUID()}.sock`);
  let left: boolean | null = null;

  registerTestCleanup(() => {
    left = existsSync(path);

    rmSync(path, { force: true });
  });

  startStubDroppingDaemon(path);

  onTestFinished(() => {
    expect(left).toBeFalse();
  });
});
