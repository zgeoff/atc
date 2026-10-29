import { expect, mock, test } from 'bun:test';
import type { HarnessRelay } from '@atc/plugin-api';
import { buildStubHarnessRelay } from '@atc/test-utils';
import { routeBridgeRelay } from './route-bridge-relay';

test('it opens the client protocol on a first line that is a peer message, which sees that line', () => {
  const stub = buildStubHarnessRelay();
  const lines: string[] = [];
  const openBridge = mock(() => {});

  routeBridgeRelay(stub.relay, {
    openBridge,
    openClient: (relay: HarnessRelay) => {
      relay.onLine((line) => {
        lines.push(line);
      });
    },
  });

  stub.sendRawLine('{"i":"m-1","p":{"u":"orpc:/daemon/hello"}}');
  stub.sendRawLine('{"i":"m-2","p":{"u":"orpc:/session/list"}}');

  expect(openBridge).not.toHaveBeenCalled();

  expect(lines).toStrictEqual([
    '{"i":"m-1","p":{"u":"orpc:/daemon/hello"}}',
    '{"i":"m-2","p":{"u":"orpc:/session/list"}}',
  ]);
});

test('it opens the session bridge on any other first line, which sees that line', () => {
  const stub = buildStubHarnessRelay();
  const lines: string[] = [];
  const openClient = mock(() => {});

  routeBridgeRelay(stub.relay, {
    openBridge: (relay: HarnessRelay) => {
      relay.onLine((line) => {
        lines.push(line);
      });
    },
    openClient,
  });

  stub.sendLine({ version: 1, id: 'n-1', op: 'status.read' });

  expect(openClient).not.toHaveBeenCalled();
  expect(lines).toStrictEqual([JSON.stringify({ version: 1, id: 'n-1', op: 'status.read' })]);
});

test('it passes the end of a routed connection to the route that opened', () => {
  const stub = buildStubHarnessRelay();
  const onEnd = mock(() => {});

  routeBridgeRelay(stub.relay, {
    openBridge: (relay: HarnessRelay) => {
      relay.onEnd(onEnd);
    },
    openClient: () => {},
  });

  stub.sendLine({ version: 1, id: 'n-1', op: 'status.read' });
  stub.emitEnd();

  expect(onEnd).toHaveBeenCalledOnce();
});

test('it closes a connection that ends before its first line', () => {
  const stub = buildStubHarnessRelay();

  routeBridgeRelay(stub.relay, { openBridge: () => {}, openClient: () => {} });

  stub.emitEnd();

  expect(stub.isClosed()).toBe(true);
});
