import { expect, onTestFinished, test } from 'bun:test';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setupTempDir } from './setup-temp-dir';
import { startStubAnsweringListener } from './start-stub-answering-listener';
import { waitFor } from './wait-for';

// A temp directory to hold the listener's socket. Disposal removes it.
function setupTest() {
  const tmp = setupTempDir('atc-stub-answering-');

  return { path: join(tmp.dir, 'answering.sock'), [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it records the first read and answers it with one line', async () => {
  using ctx = setupTest();

  await using listener = await startStubAnsweringListener(ctx.path);

  const socket = createConnection(ctx.path);

  onTestFinished(() => socket.destroy());

  const answered = Promise.withResolvers<string>();

  socket.once('data', (data) => {
    answered.resolve(data.toString());
  });

  socket.write('hello\n');

  const answer = await answered.promise;

  expect({ answer, lines: listener.lines, peers: listener.peers.length }).toStrictEqual({
    answer: 'answer\n',
    lines: ['hello\n'],
    peers: 1,
  });
});

test('it leaves every byte after the first read unread', async () => {
  using ctx = setupTest();

  await using listener = await startStubAnsweringListener(ctx.path);

  const socket = createConnection(ctx.path);

  onTestFinished(() => socket.destroy());

  const answered = Promise.withResolvers<void>();

  socket.once('data', () => {
    answered.resolve();
  });

  socket.write('hello\n');

  await answered.promise;

  socket.write('more\n');

  await waitFor(() => {
    expect(listener.peers[0]?.readableLength).toBe(5);
  });

  expect(listener.lines).toStrictEqual(['hello\n']);
});

test('it closes every connection it accepted once disposed', async () => {
  using ctx = setupTest();

  const listener = await startStubAnsweringListener(ctx.path);

  onTestFinished(() => listener[Symbol.asyncDispose]());

  const socket = createConnection(ctx.path);

  onTestFinished(() => socket.destroy());

  const closed = Promise.withResolvers<void>();

  socket.once('close', () => {
    closed.resolve();
  });

  await waitFor(() => {
    expect(listener.peers).toBeArrayOfSize(1);
  });

  await listener[Symbol.asyncDispose]();

  expect(closed.promise).resolves.toBeUndefined();
});

test('it stops listening once disposed', async () => {
  using ctx = setupTest();

  const listener = await startStubAnsweringListener(ctx.path);

  onTestFinished(() => listener[Symbol.asyncDispose]());

  await listener[Symbol.asyncDispose]();

  expect(Bun.connect({ unix: ctx.path, socket: { data() {} } })).rejects.toThrow();
});
