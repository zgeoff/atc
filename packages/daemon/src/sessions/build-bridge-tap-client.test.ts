import { expect, mock, test } from 'bun:test';
import { buildBridgeTapClient } from './build-bridge-tap-client';

test('it hands an inbox message to the bridge with its sender', () => {
  const tap = {
    takeMessage: mock<() => void>(),
    takeNotice: mock<() => void>(),
    close: mock<() => void>(),
  };

  buildBridgeTapClient(tap).sendEvent({
    v: 1,
    ev: 'InboxMessage',
    s: 's-1',
    message: 'm-1',
    from: 'planner',
    sender: { kind: 'session', session: 's-2', name: 'planner' },
    text: 'check the build',
    sentAt: 1000,
  });

  expect(tap.takeMessage).toHaveBeenCalledExactlyOnceWith({
    id: 'm-1',
    from: 'planner',
    sender: { kind: 'session', session: 's-2', name: 'planner' },
    text: 'check the build',
  });
});

test('it hands an answer notice to the bridge with its reason', () => {
  const tap = {
    takeMessage: mock<() => void>(),
    takeNotice: mock<() => void>(),
    close: mock<() => void>(),
  };

  buildBridgeTapClient(tap).sendEvent({
    v: 1,
    ev: 'InboxNotice',
    s: 's-1',
    message: 'm-1',
    from: 's-2',
    status: 'unanswered',
    reason: 'interrupted',
    at: 1000,
  });

  expect(tap.takeNotice).toHaveBeenCalledExactlyOnceWith({
    id: 'm-1',
    from: 's-2',
    status: 'unanswered',
    reason: 'interrupted',
  });
});

test('it closes the bridge tap when the daemon closes the inbox', () => {
  const tap = {
    takeMessage: mock<() => void>(),
    takeNotice: mock<() => void>(),
    close: mock<() => void>(),
  };

  buildBridgeTapClient(tap).sendEvent({ v: 1, ev: 'InboxClosed', s: 's-1', reason: 'removed' });

  expect(tap.close).toHaveBeenCalledOnce();
});

test('it drops a malformed inbox message', () => {
  const tap = {
    takeMessage: mock<() => void>(),
    takeNotice: mock<() => void>(),
    close: mock<() => void>(),
  };

  buildBridgeTapClient(tap).sendEvent({ v: 1, ev: 'InboxMessage', s: 's-1', message: 'm-1' });

  expect(tap.takeMessage).not.toHaveBeenCalled();
});
