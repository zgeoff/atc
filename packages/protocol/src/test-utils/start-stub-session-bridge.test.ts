import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { openBridgeSocket } from '../session/index';
import { startStubSessionBridge } from './start-stub-session-bridge';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-bridge-');

  return { path: join(temporaryDirectory.path, 'bridge.sock') };
}

test('it answers a tap.open request with ok under its id without asking the responder', async () => {
  const ctx = setupTest();
  const bridge = startStubSessionBridge(ctx.path, () => [{ unexpected: true }]);
  const answers: Readonly<Record<string, unknown>>[] = [];

  const socket = await openBridgeSocket(ctx.path, (line) => {
    answers.push(line);
  });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.writeLine({ version: 1, id: 'tap.open', op: 'tap.open' });

  await waitFor(() => {
    expect(answers).toStrictEqual([{ id: 'tap.open', ok: true }]);
  });

  expect(bridge.requests).toStrictEqual([{ version: 1, id: 'tap.open', op: 'tap.open' }]);
});

test('it leaves the first tap.open unanswered and answers the next when told to leave one', async () => {
  const ctx = setupTest();

  const bridge = startStubSessionBridge(ctx.path, (request) => [{ id: request['id'], ok: true }], {
    unansweredOpens: 1,
  });

  const answers: Readonly<Record<string, unknown>>[] = [];

  const socket = await openBridgeSocket(ctx.path, (line) => {
    answers.push(line);
  });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.writeLine({ version: 1, id: 'tap.open', op: 'tap.open' });
  socket.writeLine({ version: 1, id: 'note:r1', op: 'note' });
  socket.writeLine({ version: 1, id: 'tap.open', op: 'tap.open' });

  await waitFor(() => {
    expect(answers).toStrictEqual([
      { id: 'note:r1', ok: true },
      { id: 'tap.open', ok: true },
    ]);
  });

  expect(bridge.requests.map((request) => request['op'])).toStrictEqual([
    'tap.open',
    'note',
    'tap.open',
  ]);
});

test('it writes back every line the responder returns for a request', async () => {
  const ctx = setupTest();

  const bridge = startStubSessionBridge(ctx.path, (request) => [
    { id: request['id'], ok: true },
    { ev: 'InboxClosed' },
  ]);

  const answers: Readonly<Record<string, unknown>>[] = [];

  const socket = await openBridgeSocket(ctx.path, (line) => {
    answers.push(line);
  });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.writeLine({ version: 1, id: 'note:r1', op: 'note' });

  await waitFor(() => {
    expect(answers).toStrictEqual([{ id: 'note:r1', ok: true }, { ev: 'InboxClosed' }]);
  });

  expect(bridge.requests).toStrictEqual([{ version: 1, id: 'note:r1', op: 'note' }]);
});

test('it ends the connection without an answer when the responder returns null', async () => {
  const ctx = setupTest();
  const bridge = startStubSessionBridge(ctx.path, () => null);
  const answers: Readonly<Record<string, unknown>>[] = [];

  const socket = await openBridgeSocket(ctx.path, (line) => {
    answers.push(line);
  });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.writeLine({ version: 1, id: 'note:r1', op: 'note' });

  await socket.closed;

  expect(answers).toStrictEqual([]);
  expect(bridge.requests).toStrictEqual([{ version: 1, id: 'note:r1', op: 'note' }]);
});

test('it hands a line that is not JSON to the responder as an empty request', async () => {
  const ctx = setupTest();
  const received: Readonly<Record<string, unknown>>[] = [];

  const bridge = startStubSessionBridge(ctx.path, (request) => {
    received.push(request);

    return [];
  });

  const socket = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.write('not json\n');

  await waitFor(() => {
    expect(received).toStrictEqual([{}]);
  });

  expect(bridge.requests).toStrictEqual([{}]);
});

test('it hands a JSON line that is not an object to the responder as an empty request', async () => {
  const ctx = setupTest();
  const received: Readonly<Record<string, unknown>>[] = [];

  const bridge = startStubSessionBridge(ctx.path, (request) => {
    received.push(request);

    return [];
  });

  const socket = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.write('[1,2]\n');

  await waitFor(() => {
    expect(received).toStrictEqual([{}]);
  });

  expect(bridge.requests).toStrictEqual([{}]);
});

test('it buffers a partial line for each connection apart', async () => {
  const ctx = setupTest();
  const bridge = startStubSessionBridge(ctx.path, () => []);

  const first = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  registerTestCleanup(() => {
    first.end();
  });

  const second = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  registerTestCleanup(() => {
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
  const ctx = setupTest();
  const bridge = startStubSessionBridge(ctx.path, () => []);

  const socket = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.write('{"op":"fir');

  await waitFor(() => {
    expect(bridge.reads).toBe(1);
  });
});

test('it stops listening once stopped', () => {
  const ctx = setupTest();

  startStubSessionBridge(ctx.path, () => []).stop();

  expect(openBridgeSocket(ctx.path, () => {})).rejects.toThrow();
});

test('it stops listening once the test finishes without a stop', () => {
  const path = join(tmpdir(), `atc-stub-bridge-${randomUUID()}.sock`);
  let left: boolean | null = null;

  registerTestCleanup(() => {
    left = existsSync(path);

    rmSync(path, { force: true });
  });

  startStubSessionBridge(path, () => []);

  onTestFinished(() => {
    expect(left).toBeFalse();
  });
});
