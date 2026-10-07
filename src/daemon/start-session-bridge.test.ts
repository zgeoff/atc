import { expect, test } from 'bun:test';
import type { HookEvent } from '../protocol/hook-event';
import type { SessionID } from '../shared/session-id';
import { toSessionID } from '../shared/to-session-id';
import { waitFor } from '../test-utils/wait-for';
import { startSessionBridge } from './start-session-bridge';
import type { BridgeSession } from './start-session-bridge';

// A bridge over an in-memory relay, the way a provider hands one over:
// `sendLine` delivers a line from the guest, `written` holds every line the
// bridge wrote back, and `isClosed` turns true once the bridge closes the
// relay. `sessions` is the daemon's live fleet the bridge checks its
// binding against, and `hooks` collects the hook events it applied.
function setupTest() {
  const lineListeners: ((line: string) => void)[] = [];
  const written: unknown[] = [];

  const sessions = new Map<SessionID, BridgeSession>();

  const hooks: HookEvent[] = [];
  let closed = false;

  return {
    sessions,
    written,
    hooks,
    isClosed: () => closed,
    start: (binding: Parameters<typeof startSessionBridge>[1]) => {
      startSessionBridge(
        {
          onLine: (listener) => {
            lineListeners.push(listener);
          },
          onClose: () => {},
          writeLine: (line) => {
            written.push(JSON.parse(line));

            return Promise.resolve();
          },
          close: () => {
            closed = true;
          },
        },
        binding,
        {
          findSession: (sessionID) => sessions.get(sessionID),
          applyHookEvent: (e) => {
            hooks.push(e);
          },
          applyReport: () => Promise.resolve(true),
          attachTap: () => 'ok',
          ackMessage: () => Promise.resolve('unknown' as const),
          detachTap: () => {},
        },
      );
    },
    sendLine: (value: Readonly<Record<string, unknown>>) => {
      for (const listener of lineListeners) {
        listener(JSON.stringify(value));
      }
    },
  };
}

test('it answers a status read with the state of the session it is bound to', async () => {
  const bridge = setupTest();

  bridge.sessions.set(toSessionID('s1'), {
    id: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    bridgeEpoch: 3,
    state: 'needs_you',
    lastMsg: 'waiting',
  });

  bridge.start({
    sessionID: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    epoch: 3,
  });

  bridge.sendLine({ v: 1, id: 'r1', op: 'status.read' });

  await waitFor(() => {
    expect(bridge.written).toStrictEqual([
      { id: 'r1', ok: true, state: 'needs_you', lastMsg: 'waiting' },
    ]);
  });

  expect(bridge.isClosed()).toBeFalse();
});

test('it answers stale_binding and closes once the session it is bound to is gone', async () => {
  const bridge = setupTest();

  bridge.start({
    sessionID: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    epoch: 3,
  });

  bridge.sendLine({ v: 1, id: 'r1', op: 'status.read' });

  await waitFor(() => {
    expect(bridge.isClosed()).toBeTrue();
  });

  expect(bridge.written).toStrictEqual([{ id: 'r1', ok: false, code: 'stale_binding' }]);
});

test('it answers stale_binding and closes once the session started a newer harness', async () => {
  const bridge = setupTest();

  bridge.sessions.set(toSessionID('s1'), {
    id: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    bridgeEpoch: 4,
    state: 'running',
    lastMsg: 'revived',
  });

  bridge.start({
    sessionID: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    epoch: 3,
  });

  bridge.sendLine({ v: 1, id: 'r1', op: 'tap.open' });

  await waitFor(() => {
    expect(bridge.isClosed()).toBeTrue();
  });

  expect(bridge.written).toStrictEqual([{ id: 'r1', ok: false, code: 'stale_binding' }]);
});

test('it answers stale_binding and closes for a session bound to another target identity', async () => {
  const bridge = setupTest();

  bridge.sessions.set(toSessionID('s1'), {
    id: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:b',
    hostKey: toSessionID('s1'),
    bridgeEpoch: 3,
    state: 'running',
    lastMsg: 'started',
  });

  bridge.start({
    sessionID: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    epoch: 3,
  });

  bridge.sendLine({ v: 1, id: 'r1', op: 'status.read' });

  await waitFor(() => {
    expect(bridge.isClosed()).toBeTrue();
  });

  expect(bridge.written).toStrictEqual([{ id: 'r1', ok: false, code: 'stale_binding' }]);
});

test('it applies a hook line for the session it is bound to', async () => {
  const bridge = setupTest();

  bridge.sessions.set(toSessionID('s1'), {
    id: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    bridgeEpoch: 3,
    state: 'running',
    lastMsg: 'started',
  });

  bridge.start({
    sessionID: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    epoch: 3,
  });

  bridge.sendLine({ atcId: 's1', event: 'Notification', payload: { message: 'own' } });

  await waitFor(() => {
    expect(bridge.hooks).toStrictEqual([
      { atcId: toSessionID('s1'), event: 'Notification', payload: { message: 'own' } },
    ]);
  });
});

test('it answers forbidden and closes for a hook line of another session', async () => {
  const bridge = setupTest();

  bridge.sessions.set(toSessionID('s1'), {
    id: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    bridgeEpoch: 3,
    state: 'running',
    lastMsg: 'started',
  });

  bridge.start({
    sessionID: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    epoch: 3,
  });

  bridge.sendLine({ atcId: 's2', event: 'Notification', payload: { message: 'forged' } });

  await waitFor(() => {
    expect(bridge.isClosed()).toBeTrue();
  });

  expect({ hooks: bridge.hooks, written: bridge.written }).toStrictEqual({
    hooks: [],
    written: [{ id: null, ok: false, code: 'forbidden' }],
  });
});
