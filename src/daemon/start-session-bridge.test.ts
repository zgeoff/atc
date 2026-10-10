import { expect, mock, test } from 'bun:test';
import type { SessionID } from '../shared/session-id';
import { toSessionID } from '../shared/to-session-id';
import { buildStubBridgeContext } from '../test-utils/build-stub-bridge-context';
import { buildStubHarnessRelay } from '../test-utils/build-stub-harness-relay';
import { waitFor } from '../test-utils/wait-for';
import { startSessionBridge } from './start-session-bridge';
import type { BridgeContext, BridgeSession } from './start-session-bridge';

// An in-memory relay, the way a provider hands one over, and the daemon's
// side of a bridge: the live fleet the bridge checks its binding against,
// and a recorder of every hook event the bridge applied.
function setupTest() {
  const sessions = new Map<SessionID, BridgeSession>();

  const applyHookEvent = mock<BridgeContext['applyHookEvent']>();

  const daemon = buildStubBridgeContext({
    findSession: (sessionID) => sessions.get(sessionID),
    applyHookEvent,
  });

  return { stub: buildStubHarnessRelay(), sessions, applyHookEvent, daemon };
}

test('it answers a status read with the state of the session it is bound to', async () => {
  const ctx = setupTest();

  ctx.sessions.set(toSessionID('s1'), {
    id: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    bridgeEpoch: 3,
    state: 'needs_you',
    lastMsg: 'waiting',
  });

  startSessionBridge(
    ctx.stub.relay,
    {
      sessionID: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('s1'),
      epoch: 3,
    },
    ctx.daemon,
  );

  ctx.stub.sendLine({ v: 1, id: 'r1', op: 'status.read' });

  await waitFor(() => {
    expect(ctx.stub.written).toStrictEqual([
      { id: 'r1', ok: true, state: 'needs_you', lastMsg: 'waiting' },
    ]);
  });

  expect(ctx.stub.isClosed()).toBeFalse();
});

test('it answers stale_binding and closes once the session it is bound to is gone', async () => {
  const ctx = setupTest();

  startSessionBridge(
    ctx.stub.relay,
    {
      sessionID: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('s1'),
      epoch: 3,
    },
    ctx.daemon,
  );

  ctx.stub.sendLine({ v: 1, id: 'r1', op: 'status.read' });

  await waitFor(() => {
    expect(ctx.stub.isClosed()).toBeTrue();
  });

  expect(ctx.stub.written).toStrictEqual([{ id: 'r1', ok: false, code: 'stale_binding' }]);
});

test('it answers stale_binding and closes once the session started a newer harness', async () => {
  const ctx = setupTest();

  ctx.sessions.set(toSessionID('s1'), {
    id: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    bridgeEpoch: 4,
    state: 'running',
    lastMsg: 'revived',
  });

  startSessionBridge(
    ctx.stub.relay,
    {
      sessionID: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('s1'),
      epoch: 3,
    },
    ctx.daemon,
  );

  ctx.stub.sendLine({ v: 1, id: 'r1', op: 'tap.open' });

  await waitFor(() => {
    expect(ctx.stub.isClosed()).toBeTrue();
  });

  expect(ctx.stub.written).toStrictEqual([{ id: 'r1', ok: false, code: 'stale_binding' }]);
});

test('it answers stale_binding and closes for a session bound to another target identity', async () => {
  const ctx = setupTest();

  ctx.sessions.set(toSessionID('s1'), {
    id: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:b',
    hostKey: toSessionID('s1'),
    bridgeEpoch: 3,
    state: 'running',
    lastMsg: 'started',
  });

  startSessionBridge(
    ctx.stub.relay,
    {
      sessionID: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('s1'),
      epoch: 3,
    },
    ctx.daemon,
  );

  ctx.stub.sendLine({ v: 1, id: 'r1', op: 'status.read' });

  await waitFor(() => {
    expect(ctx.stub.isClosed()).toBeTrue();
  });

  expect(ctx.stub.written).toStrictEqual([{ id: 'r1', ok: false, code: 'stale_binding' }]);
});

test('it applies a hook line for the session it is bound to', async () => {
  const ctx = setupTest();

  ctx.sessions.set(toSessionID('s1'), {
    id: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    bridgeEpoch: 3,
    state: 'running',
    lastMsg: 'started',
  });

  startSessionBridge(
    ctx.stub.relay,
    {
      sessionID: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('s1'),
      epoch: 3,
    },
    ctx.daemon,
  );

  ctx.stub.sendLine({ atcId: 's1', event: 'Notification', payload: { message: 'own' } });

  await waitFor(() => {
    expect(ctx.applyHookEvent).toHaveBeenCalledExactlyOnceWith({
      atcId: toSessionID('s1'),
      event: 'Notification',
      payload: { message: 'own' },
    });
  });
});

test('it answers forbidden and closes for a hook line of another session', async () => {
  const ctx = setupTest();

  ctx.sessions.set(toSessionID('s1'), {
    id: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    bridgeEpoch: 3,
    state: 'running',
    lastMsg: 'started',
  });

  startSessionBridge(
    ctx.stub.relay,
    {
      sessionID: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('s1'),
      epoch: 3,
    },
    ctx.daemon,
  );

  ctx.stub.sendLine({ atcId: 's2', event: 'Notification', payload: { message: 'forged' } });

  await waitFor(() => {
    expect(ctx.stub.isClosed()).toBeTrue();
  });

  expect(ctx.applyHookEvent).not.toHaveBeenCalled();
  expect(ctx.stub.written).toStrictEqual([{ id: null, ok: false, code: 'forbidden' }]);
});

test("it answers forbidden and closes for a request to add to its own session's scope", async () => {
  const ctx = setupTest();

  ctx.sessions.set(toSessionID('s1'), {
    id: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    bridgeEpoch: 3,
    state: 'running',
    lastMsg: 'started',
  });

  startSessionBridge(
    ctx.stub.relay,
    {
      sessionID: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('s1'),
      epoch: 3,
    },
    ctx.daemon,
  );

  ctx.stub.sendLine({
    v: 1,
    id: 'r1',
    op: 'session.scope.add',
    session: 's1',
    scope: { worktrees: [{ path: '/' }] },
  });

  await waitFor(() => {
    expect(ctx.stub.isClosed()).toBeTrue();
  });

  expect(ctx.stub.written).toStrictEqual([{ id: 'r1', ok: false, code: 'forbidden' }]);
});

test('it applies a note sent in the legacy report envelope under its report id', async () => {
  const ctx = setupTest();
  const applyNote = mock<BridgeContext['applyNote']>(() => Promise.resolve(true));

  const daemon = buildStubBridgeContext({
    findSession: (sessionID) => ctx.sessions.get(sessionID),
    applyNote,
  });

  ctx.sessions.set(toSessionID('s1'), {
    id: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    bridgeEpoch: 3,
    state: 'running',
    lastMsg: 'started',
  });

  startSessionBridge(
    ctx.stub.relay,
    {
      sessionID: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('s1'),
      epoch: 3,
    },
    daemon,
  );

  ctx.stub.sendLine({
    v: 1,
    id: 'report:r1',
    op: 'report',
    reportID: 'r1',
    payload: { kind: 'note', text: 'hi' },
  });

  await waitFor(() => {
    expect(ctx.stub.written).toStrictEqual([{ id: 'report:r1', ok: true }]);
  });

  expect(applyNote).toHaveBeenCalledWith(toSessionID('s1'), { kind: 'note', text: 'hi' }, 'r1');
});
