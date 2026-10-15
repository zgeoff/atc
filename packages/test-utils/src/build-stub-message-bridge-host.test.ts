import { expect, mock, test } from 'bun:test';
import { buildStubMessageBridgeHost } from './build-stub-message-bridge-host';

test('it hands an attached tap one queued message and the next only after its ack', async () => {
  const stub = buildStubMessageBridgeHost();
  const takeMessage = mock<() => void>();

  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'first' });
  stub.queueMessage({ id: 'm-2', from: 'planner', text: 'second' });
  stub.host.attachTap({ takeMessage, takeNotice: mock<() => void>(), close: mock<() => void>() });

  expect(takeMessage).toHaveBeenCalledExactlyOnceWith({
    id: 'm-1',
    from: 'planner',
    text: 'first',
  });

  await stub.host.ackMessage('m-1');

  expect(takeMessage).toHaveBeenLastCalledWith({ id: 'm-2', from: 'planner', text: 'second' });
  expect(stub.statuses.get('m-1')).toBe('delivered');
});

test('it hands an attached tap a queued notice before a queued message, and the message after its ack', async () => {
  const stub = buildStubMessageBridgeHost();
  const takeMessage = mock<() => void>();
  const takeNotice = mock<() => void>();

  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'first' });
  stub.queueNotice({ id: 'm-0', from: 'reviewer', status: 'answered', answer: 'looks fine' });
  stub.host.attachTap({ takeMessage, takeNotice, close: mock<() => void>() });

  expect(takeNotice).toHaveBeenCalledExactlyOnceWith({
    id: 'm-0',
    from: 'reviewer',
    status: 'answered',
    answer: 'looks fine',
  });

  expect(takeMessage).not.toHaveBeenCalled();

  await stub.host.ackNotice('m-0');

  expect(takeMessage).toHaveBeenCalledExactlyOnceWith({
    id: 'm-1',
    from: 'planner',
    text: 'first',
  });

  expect(stub.noticeStatuses.get('m-0')).toBe('delivered');
});

test('it hands a message queued while the tap holds a notice only after the notice ack', async () => {
  const stub = buildStubMessageBridgeHost();
  const takeMessage = mock<() => void>();

  stub.host.attachTap({ takeMessage, takeNotice: mock<() => void>(), close: mock<() => void>() });
  stub.queueNotice({ id: 'm-0', from: 'reviewer', status: 'answered', answer: 'looks fine' });
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'first' });

  const handedBeforeAck = takeMessage.mock.calls.length;

  await stub.host.ackNotice('m-0');

  expect(handedBeforeAck).toBe(0);

  expect(takeMessage).toHaveBeenCalledExactlyOnceWith({
    id: 'm-1',
    from: 'planner',
    text: 'first',
  });
});

test('it hands a message queued while the tap holds another only after the first one settles', async () => {
  const stub = buildStubMessageBridgeHost();
  const takeMessage = mock<() => void>();

  stub.host.attachTap({ takeMessage, takeNotice: mock<() => void>(), close: mock<() => void>() });
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'first' });
  stub.queueMessage({ id: 'm-2', from: 'planner', text: 'second' });

  const handedBeforeNote = takeMessage.mock.calls.length;

  await stub.host.applyNote({ kind: 'unanswered', messages: ['m-1'], reason: 'error' });

  expect(handedBeforeNote).toBe(1);
  expect(takeMessage).toHaveBeenLastCalledWith({ id: 'm-2', from: 'planner', text: 'second' });
});

test('it hands a notice the last tap never acked to the next tap', () => {
  const stub = buildStubMessageBridgeHost();

  const first = {
    takeMessage: mock<() => void>(),
    takeNotice: mock<() => void>(),
    close: mock<() => void>(),
  };

  const second = {
    takeMessage: mock<() => void>(),
    takeNotice: mock<() => void>(),
    close: mock<() => void>(),
  };

  stub.host.attachTap(first);
  stub.queueNotice({ id: 'm-0', from: 'reviewer', status: 'unanswered', reason: 'error' });
  stub.host.detachTap(first);
  stub.host.attachTap(second);

  expect(second.takeNotice).toHaveBeenCalledExactlyOnceWith({
    id: 'm-0',
    from: 'reviewer',
    status: 'unanswered',
    reason: 'error',
  });

  expect(stub.noticeStatuses.get('m-0')).toBe('queued');
});

test('it hands a detached tap nothing', () => {
  const stub = buildStubMessageBridgeHost();

  const tap = {
    takeMessage: mock<() => void>(),
    takeNotice: mock<() => void>(),
    close: mock<() => void>(),
  };

  stub.host.attachTap(tap);
  stub.host.detachTap(tap);
  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'first' });

  expect(tap.takeMessage).not.toHaveBeenCalled();
});

test('it settles only an unsettled message and records each note it reads', async () => {
  const stub = buildStubMessageBridgeHost([
    { id: 'm-1', status: 'delivered' },
    { id: 'm-2', status: 'queued' },
  ]);

  await stub.host.applyNote({ kind: 'answered', messages: ['m-1'], answer: 'done', turn: 't-1' });
  await stub.host.applyNote({ kind: 'unanswered', messages: ['m-1', 'm-2'], reason: 'error' });

  expect([...stub.statuses]).toStrictEqual([
    ['m-1', 'answered'],
    ['m-2', 'unanswered'],
  ]);

  expect(stub.notes).toHaveLength(2);
});

test('it refuses a note payload it cannot read', async () => {
  const stub = buildStubMessageBridgeHost();

  const read = await stub.host.applyNote({ kind: 'shrug' });

  expect(read).toBe(false);
  expect(stub.notes).toStrictEqual([]);
});

test('it lists queued and delivered messages as unsettled', async () => {
  const stub = buildStubMessageBridgeHost([
    { id: 'm-1', status: 'delivered' },
    { id: 'm-2', status: 'queued' },
  ]);

  await stub.host.applyNote({ kind: 'answered', message: 'm-1', answer: 'done' });

  const unsettled = await stub.host.collectUnsettledMessages();

  expect(unsettled).toStrictEqual([{ id: 'm-2', status: 'queued' }]);
});

test('it counts attaches and records log lines', () => {
  const stub = buildStubMessageBridgeHost();

  stub.host.attachTap({
    takeMessage: mock<() => void>(),
    takeNotice: mock<() => void>(),
    close: mock<() => void>(),
  });

  stub.host.log('one line');

  expect(stub.attaches).toBe(1);
  expect(stub.logs).toStrictEqual(['one line']);
});

test('it hands the tap the next queued message once a note settles the one before', async () => {
  const stub = buildStubMessageBridgeHost();
  const takeMessage = mock<() => void>();

  stub.queueMessage({ id: 'm-1', from: 'planner', text: 'first' });
  stub.queueMessage({ id: 'm-2', from: 'planner', text: 'second' });
  stub.host.attachTap({ takeMessage, takeNotice: mock<() => void>(), close: mock<() => void>() });

  await stub.host.applyNote({ kind: 'unanswered', messages: ['m-1'], reason: 'error' });

  expect(takeMessage).toHaveBeenLastCalledWith({ id: 'm-2', from: 'planner', text: 'second' });
});
