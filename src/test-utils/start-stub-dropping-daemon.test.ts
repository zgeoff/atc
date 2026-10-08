import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { setupTempDir } from './setup-temp-dir';
import { startStubDroppingDaemon } from './start-stub-dropping-daemon';
import { waitFor } from './wait-for';

// A temp directory to hold the daemon's socket. Disposal removes it.
function setupTest() {
  const tmp = setupTempDir('atc-dropping-daemon-');

  return { socketPath: join(tmp.dir, 'daemon.sock'), [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it announces the first features on the first handshake', async () => {
  using ctx = setupTest();

  const daemon = startStubDroppingDaemon(ctx.socketPath, {
    features: ['spawn.idempotency'],
    retryFeatures: [],
  });

  onTestFinished(() => {
    daemon.stop();
  });

  const client = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test-build')).resolves.toStrictEqual({
    daemon: 'atc/dropping-build',
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    lastUsedAgent: 'claude',
    features: ['spawn.idempotency'],
  });
});

test('it announces the retry features on a later handshake', async () => {
  using ctx = setupTest();

  const daemon = startStubDroppingDaemon(ctx.socketPath, {
    features: ['spawn.idempotency'],
    retryFeatures: [],
  });

  onTestFinished(() => {
    daemon.stop();
  });

  const first = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    first.stop();
  });

  await first.sendHello('atc/test-build');

  const second = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    second.stop();
  });

  expect(second.sendHello('atc/test-build')).resolves.toStrictEqual({
    daemon: 'atc/dropping-build',
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    lastUsedAgent: 'claude',
    features: [],
  });
});

test('it announces the first features on a later handshake when given no retry features', async () => {
  using ctx = setupTest();

  const daemon = startStubDroppingDaemon(ctx.socketPath, { features: ['spawn.idempotency'] });

  onTestFinished(() => {
    daemon.stop();
  });

  const first = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    first.stop();
  });

  await first.sendHello('atc/test-build');

  const second = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    second.stop();
  });

  expect(second.sendHello('atc/test-build')).resolves.toStrictEqual({
    daemon: 'atc/dropping-build',
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    lastUsedAgent: 'claude',
    features: ['spawn.idempotency'],
  });
});

test('it drops the connection of the first request without answering it', async () => {
  using ctx = setupTest();

  const daemon = startStubDroppingDaemon(ctx.socketPath, { features: [] });

  onTestFinished(() => {
    daemon.stop();
  });

  const client = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  expect(client.sendRequest('session.spawn', { idempotencyKey: 'k-1' })).rejects.toMatchObject({
    code: 'internal',
    message: 'connection closed',
  });
});

test('it answers a later request with a session and records each request key', async () => {
  using ctx = setupTest();
  using daemon = startStubDroppingDaemon(ctx.socketPath, { features: [] });

  const first = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    first.stop();
  });

  await first.sendHello('atc/test-build');
  await first.sendRequest('session.spawn', { idempotencyKey: 'k-1' }).catch(() => null);

  const second = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    second.stop();
  });

  await second.sendHello('atc/test-build');

  const answered = await second.sendRequest('session.spawn', {});

  expect(answered).toStrictEqual({ session: { id: 's-1' } });
  expect(daemon.keys).toStrictEqual(['k-1', undefined]);
});

test('it stops listening when disposed', () => {
  using ctx = setupTest();

  const daemon = startStubDroppingDaemon(ctx.socketPath, { features: [] });

  daemon[Symbol.dispose]();

  expect(DaemonClient.open(ctx.socketPath)).rejects.toThrow();
});

test('it counts each read it takes from a connection', async () => {
  using ctx = setupTest();
  using daemon = startStubDroppingDaemon(ctx.socketPath, { features: [] });

  const raw = await Bun.connect({ unix: ctx.socketPath, socket: { data() {} } });

  onTestFinished(() => {
    raw.end();
  });

  raw.write('{"v":4,');

  await waitFor(() => {
    expect(daemon.reads).toBe(1);
  });
});

test('it reads a request split across two writes as one request', async () => {
  using ctx = setupTest();
  using daemon = startStubDroppingDaemon(ctx.socketPath, { features: [] });

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

  onTestFinished(() => {
    raw.end();
  });

  raw.write('{"v":4,"id":1,"m":"session.spawn",');

  await waitFor(() => {
    expect(daemon.reads).toBe(1);
  });

  raw.write('"p":{"idempotencyKey":"k-split"}}\n');

  await closed.promise;

  expect(daemon.keys).toStrictEqual(['k-split']);
});

test('it stops listening once the test finishes without a dispose', () => {
  // The socket sits outside any directory the test removes, so only the
  // listener's own stop takes it away.
  const path = join(tmpdir(), `atc-stub-dropping-${randomUUID()}.sock`);

  startStubDroppingDaemon(path, { features: [] });

  onTestFinished(() => {
    expect(existsSync(path)).toBeFalse();
  });
});
