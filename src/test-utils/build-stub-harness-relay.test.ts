import { expect, mock, test } from 'bun:test';
import { buildStubHarnessRelay } from './build-stub-harness-relay';

test('it delivers a sent value to every line listener as one JSON line', () => {
  const stub = buildStubHarnessRelay();
  const first = mock<(line: string) => void>();
  const second = mock<(line: string) => void>();

  stub.relay.onLine(first);
  stub.relay.onLine(second);
  stub.sendLine({ v: 1, id: 'r1', op: 'status.read' });

  expect([first.mock.calls, second.mock.calls]).toStrictEqual([
    [['{"v":1,"id":"r1","op":"status.read"}']],
    [['{"v":1,"id":"r1","op":"status.read"}']],
  ]);
});

test('it records each written line parsed, in the order it was written', async () => {
  const stub = buildStubHarnessRelay();

  await stub.relay.writeLine('{"id":"r1","ok":true}');
  await stub.relay.writeLine('{"id":"r2","ok":false}');

  expect(stub.written).toStrictEqual([
    { id: 'r1', ok: true },
    { id: 'r2', ok: false },
  ]);
});

test('it reports the relay open until it is closed', () => {
  expect(buildStubHarnessRelay().isClosed()).toBeFalse();
});

test('it reports the relay closed once it is closed', () => {
  const stub = buildStubHarnessRelay();

  stub.relay.close();

  expect(stub.isClosed()).toBeTrue();
});

test('it runs every close listener when the guest hangs up', () => {
  const stub = buildStubHarnessRelay();
  const first = mock<() => void>();
  const second = mock<() => void>();

  stub.relay.onClose(first);
  stub.relay.onClose(second);
  stub.hangUp();

  expect([first.mock.calls.length, second.mock.calls.length]).toStrictEqual([1, 1]);
});

test('it runs no close listener when the daemon closes the relay', () => {
  const stub = buildStubHarnessRelay();
  const listener = mock<() => void>();

  stub.relay.onClose(listener);
  stub.relay.close();

  expect(listener).not.toHaveBeenCalled();
});
