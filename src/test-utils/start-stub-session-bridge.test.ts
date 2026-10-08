import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('it hands a line that is not JSON to the responder as an empty request', async () => {
  using ctx = setupTest();

  const received: Readonly<Record<string, unknown>>[] = [];

  using bridge = startStubSessionBridge(ctx.path, (request) => {
    received.push(request);

    return [];
  });

  const socket = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  onTestFinished(() => {
    socket.end();
  });

  socket.write('not json\n');

  await waitFor(() => {
    expect({ received, requests: bridge.requests }).toStrictEqual({
      received: [{}],
      requests: [{}],
    });
  });
});

test('it hands a JSON line that is not an object to the responder as an empty request', async () => {
  using ctx = setupTest();

  const received: Readonly<Record<string, unknown>>[] = [];

  using bridge = startStubSessionBridge(ctx.path, (request) => {
    received.push(request);

    return [];
  });

  const socket = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  onTestFinished(() => {
    socket.end();
  });

  socket.write('[1,2]\n');

  await waitFor(() => {
    expect({ received, requests: bridge.requests }).toStrictEqual({
      received: [{}],
      requests: [{}],
    });
  });
});

test('it buffers a partial line for each connection apart', async () => {
  using ctx = setupTest();
  using bridge = startStubSessionBridge(ctx.path, () => []);

  const first = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  onTestFinished(() => {
    first.end();
  });

  const second = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  onTestFinished(() => {
    second.end();
  });

  first.write('{"op":"fir');
  second.write('{"op":"sec');

  await waitFor(() => {
    expect(bridge.reads).toBe(2);
  });

  first.write('st"}\n');
  second.write('ond"}\n');

  await waitFor(() => {
    expect(bridge.requests).toIncludeSameMembers([{ op: 'first' }, { op: 'second' }]);
  });
});

test('it counts each read it takes from a connection', async () => {
  using ctx = setupTest();
  using bridge = startStubSessionBridge(ctx.path, () => []);

  const socket = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  onTestFinished(() => {
    socket.end();
  });

  socket.write('{"op":"fir');

  await waitFor(() => {
    expect(bridge.reads).toBe(1);
  });
});

test('it stops listening once disposed', () => {
  using ctx = setupTest();

  startStubSessionBridge(ctx.path, () => [])[Symbol.dispose]();

  expect(openBridgeSocket(ctx.path, () => {})).rejects.toThrow();
});

test('it stops listening once the test finishes without a dispose', () => {
  // The socket sits outside any directory the test removes, so only the
  // listener's own stop takes it away.
  const path = join(tmpdir(), `atc-stub-bridge-${randomUUID()}.sock`);

  startStubSessionBridge(path, () => []);

  onTestFinished(() => {
    expect(existsSync(path)).toBeFalse();
  });
});

test('it stops once when disposed before the test finishes', () => {
  const path = join(tmpdir(), `atc-stub-bridge-${randomUUID()}.sock`);
  const bridge = startStubSessionBridge(path, () => []);

  bridge[Symbol.dispose]();

  expect(existsSync(path)).toBeFalse();
});
