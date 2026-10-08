import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubRestoreDaemon } from './start-stub-restore-daemon';

// A temp directory holding the stub daemon's socket, with the daemon started.
function setupTest() {
  const tmp = setupTempDir('atc-stub-restore-daemon-');
  const socketPath = join(tmp.dir, 'daemon.sock');
  const daemon = startStubRestoreDaemon(socketPath);

  return { socketPath, daemon };
}

test('it answers a fleet restore with an empty result', async () => {
  const ctx = setupTest();

  const client = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  const restored = await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(restored).toStrictEqual({});
});

test('it answers each session list with the next reply the test pushed', async () => {
  const ctx = setupTest();

  const client = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  ctx.daemon.lists.push({ sessions: [{ id: 's-1' }] }, { sessions: [] });

  const first = await client.sendRequest('session.list');
  const second = await client.sendRequest('session.list');

  expect(first).toStrictEqual({ sessions: [{ id: 's-1' }] });
  expect(second).toStrictEqual({ sessions: [] });
});

test('it withholds the answer to a session list once no reply is left', async () => {
  const ctx = setupTest();

  const client = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  const listed = client.sendRequest('session.list');

  // Closing the client rejects the withheld list; nothing awaits it.
  void Promise.allSettled([listed]);

  // The stub answers in arrival order on one connection, so an answer to
  // the list would reach the client before the restore's.
  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(Bun.peek.status(listed)).toBe('pending');
});

test('it records the method of each request in order', async () => {
  const ctx = setupTest();

  const client = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  ctx.daemon.lists.push({ sessions: [] });

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  await client.sendRequest('session.list');

  expect(ctx.daemon.methods).toStrictEqual(['fleet.restore', 'session.list']);
});

test('it answers a client whose line another client left half written', async () => {
  const ctx = setupTest();

  const client = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  const answered = Promise.withResolvers<void>();

  const raw = await Bun.connect({
    unix: ctx.socketPath,
    socket: {
      data() {
        answered.resolve();
      },
    },
  });

  registerTestCleanup(() => {
    raw.end();
  });

  raw.write('{"v":4,"id":1,"m":"fleet.restore","p":{"cols":80,"rows":24}}\n{"v":4,"id":2,');

  await answered.promise;

  const restored = await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(restored).toStrictEqual({});
});

test('it stops listening once disposed', () => {
  const ctx = setupTest();

  ctx.daemon[Symbol.dispose]();

  expect(DaemonClient.open(ctx.socketPath)).rejects.toThrow();
});

test('it stops listening once the test finishes without a dispose', () => {
  // The socket sits outside any directory the test removes, so only the
  // listener's own stop takes it away.
  const path = join(tmpdir(), `atc-stub-restore-${randomUUID()}.sock`);

  startStubRestoreDaemon(path);

  onTestFinished(() => {
    expect(existsSync(path)).toBeFalse();
  });
});
