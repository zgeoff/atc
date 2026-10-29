import { expect, mock, test } from 'bun:test';
import type { HarnessRelay } from '@atc/plugin-api';
import { buildStubHarnessRelay } from '@atc/test-utils';
import { createRelayPeerSocket } from './create-relay-peer-socket';

test('it writes each whole line to the relay and keeps a partial line for the next write', async () => {
  const stub = buildStubHarnessRelay();
  const drained = Promise.withResolvers<void>();

  const socket = createRelayPeerSocket(stub.relay, () => {
    drained.resolve();
  });

  const encoder = new TextEncoder();

  const first = socket.write(encoder.encode('{"line":"1"}\n{"line":'));

  await drained.promise;

  const second = socket.write(encoder.encode('"2"}\n'));

  expect(first).toBe(21);
  expect(second).toBe(5);
  expect(stub.written).toStrictEqual([{ line: '1' }, { line: '2' }]);
});

test('it takes no bytes while a line waits for room in the relay, and drains once it has gone', async () => {
  const room = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  const written: string[] = [];

  const onDrain = mock(() => {
    drained.resolve();
  });

  const relay: HarnessRelay = {
    ...buildStubHarnessRelay().relay,
    writeLine: (line) => {
      written.push(line);

      return room.promise;
    },
  };

  const socket = createRelayPeerSocket(relay, onDrain);

  const encoder = new TextEncoder();

  socket.write(encoder.encode('{"i":"1"}\n'));

  const held = socket.write(encoder.encode('{"i":"2"}\n'));

  room.resolve();

  await drained.promise;

  expect(held).toBe(0);
  expect(written).toStrictEqual(['{"i":"1"}']);
  expect(onDrain).toHaveBeenCalledOnce();
});

test('it closes the relay when the connection ends the socket', () => {
  const stub = buildStubHarnessRelay();
  const socket = createRelayPeerSocket(stub.relay, () => {});

  socket.end();

  expect(stub.isClosed()).toBe(true);
});
