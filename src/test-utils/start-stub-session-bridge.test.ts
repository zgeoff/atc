import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { openBridgeSocket } from '../protocol/open-bridge-socket';
import { setupTempDir } from './setup-temp-dir';
import { startStubSessionBridge } from './start-stub-session-bridge';
import { waitFor } from './wait-for';

/**
 * A temp directory to hold the stub bridge's socket. Disposal removes it.
 */
function setupTest() {
  const tmp = setupTempDir('atc-stub-bridge-');

  return { path: join(tmp.dir, 'bridge.sock'), [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it answers a tap.open request with ok under its id without asking the responder', async () => {
  using ctx = setupTest();
  using bridge = startStubSessionBridge(ctx.path, () => [{ unexpected: true }]);

  const answers: Readonly<Record<string, unknown>>[] = [];

  const socket = await openBridgeSocket(ctx.path, (line) => {
    answers.push(line);
  });

  onTestFinished(() => {
    socket.end();
  });

  socket.writeLine({ v: 1, id: 'tap.open', op: 'tap.open' });

  await waitFor(() => {
    expect({ answers, requests: bridge.requests }).toStrictEqual({
      answers: [{ id: 'tap.open', ok: true }],
      requests: [{ v: 1, id: 'tap.open', op: 'tap.open' }],
    });
  });
});

test('it writes back every line the responder returns for a request', async () => {
  using ctx = setupTest();

  using bridge = startStubSessionBridge(ctx.path, (request) => [
    { id: request['id'], ok: true },
    { ev: 'InboxClosed' },
  ]);

  const answers: Readonly<Record<string, unknown>>[] = [];

  const socket = await openBridgeSocket(ctx.path, (line) => {
    answers.push(line);
  });

  onTestFinished(() => {
    socket.end();
  });

  socket.writeLine({ v: 1, id: 'report:r1', op: 'report' });

  await waitFor(() => {
    expect({ answers, requests: bridge.requests }).toStrictEqual({
      answers: [{ id: 'report:r1', ok: true }, { ev: 'InboxClosed' }],
      requests: [{ v: 1, id: 'report:r1', op: 'report' }],
    });
  });
});

test('it ends the connection without an answer when the responder returns null', async () => {
  using ctx = setupTest();
  using bridge = startStubSessionBridge(ctx.path, () => null);

  const answers: Readonly<Record<string, unknown>>[] = [];

  const socket = await openBridgeSocket(ctx.path, (line) => {
    answers.push(line);
  });

  onTestFinished(() => {
    socket.end();
  });

  socket.writeLine({ v: 1, id: 'report:r1', op: 'report' });

  await socket.closed;

  expect({ answers, requests: bridge.requests }).toStrictEqual({
    answers: [],
    requests: [{ v: 1, id: 'report:r1', op: 'report' }],
  });
});

test('it hands a line that is not a JSON object to the responder as an empty request', async () => {
  using ctx = setupTest();
  using bridge = startStubSessionBridge(ctx.path, () => []);

  const socket = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  onTestFinished(() => {
    socket.end();
  });

  socket.write('not json\n');

  await waitFor(() => {
    expect(bridge.requests).toStrictEqual([{}]);
  });
});

test('it stops listening once disposed', () => {
  using ctx = setupTest();

  startStubSessionBridge(ctx.path, () => [])[Symbol.dispose]();

  expect(openBridgeSocket(ctx.path, () => {})).rejects.toThrow();
});
