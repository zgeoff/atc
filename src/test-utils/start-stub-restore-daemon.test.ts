import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { setupTempDir } from './setup-temp-dir';
import { startStubRestoreDaemon } from './start-stub-restore-daemon';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-stub-restore-daemon-'));
  const daemon = stack.use(startStubRestoreDaemon(join(tmp.dir, 'daemon.sock')));

  const client = await DaemonClient.open(join(tmp.dir, 'daemon.sock'));

  stack.defer(() => {
    client.stop();
  });

  const owned = stack.move();

  return { dir: tmp.dir, daemon, client, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it answers a fleet restore with an empty result', async () => {
  await using ctx = await setupTest();

  const restored = await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(restored).toStrictEqual({});
});

test('it answers each session list with the next reply the test pushed', async () => {
  await using ctx = await setupTest();

  ctx.daemon.lists.push({ sessions: [{ id: 's-1' }] }, { sessions: [] });

  const first = await ctx.client.sendRequest('session.list');
  const second = await ctx.client.sendRequest('session.list');

  expect([first, second]).toStrictEqual([{ sessions: [{ id: 's-1' }] }, { sessions: [] }]);
});

test('it withholds the answer to a session list once no reply is left', async () => {
  await using ctx = await setupTest();

  const listed = ctx.client.sendRequest('session.list');

  // Closing the client rejects the withheld list; nothing awaits it.
  void Promise.allSettled([listed]);

  // The stub answers in arrival order on one connection, so an answer to
  // the list would reach the client before the restore's.
  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(Bun.peek.status(listed)).toBe('pending');
});

test('it records the method of each request in order', async () => {
  await using ctx = await setupTest();

  ctx.daemon.lists.push({ sessions: [] });

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  await ctx.client.sendRequest('session.list');

  expect(ctx.daemon.methods).toStrictEqual(['fleet.restore', 'session.list']);
});

test('it stops listening once disposed', async () => {
  await using ctx = await setupTest();

  ctx.daemon[Symbol.dispose]();

  expect(DaemonClient.open(join(ctx.dir, 'daemon.sock'))).rejects.toThrow();
});
