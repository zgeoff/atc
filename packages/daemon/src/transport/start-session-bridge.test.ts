import { expect, mock, test } from 'bun:test';
import type { SessionID } from '@atc/core';
import { toMessageID, toSessionID } from '@atc/core';
import { buildStubHarnessRelay, waitFor } from '@atc/test-utils';
import { buildStubBridgeContext } from '../testing/build-stub-bridge-context';
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

  ctx.stub.sendLine({ version: 1, id: 'r1', op: 'status.read' });

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

  ctx.stub.sendLine({ version: 1, id: 'r1', op: 'status.read' });

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

  ctx.stub.sendLine({ version: 1, id: 'r1', op: 'tap.open' });

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

  ctx.stub.sendLine({ version: 1, id: 'r1', op: 'status.read' });

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

test('it closes the relay of a guest that ended after it sent a hook line', async () => {
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

  ctx.stub.sendLine({ atcId: 's1', event: 'Stop', payload: {} });
  ctx.stub.emitEnd();

  await waitFor(() => {
    expect(ctx.stub.isClosed()).toBeTrue();
  });

  expect(ctx.applyHookEvent).toHaveBeenCalledExactlyOnceWith({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: {},
  });
});

test('it answers a note before it closes the relay of a guest that ended after sending it', async () => {
  const ctx = setupTest();
  const recorded = Promise.withResolvers<boolean>();
  const applyNote = mock<BridgeContext['applyNote']>(() => recorded.promise);

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
    version: 1,
    id: 'note:n1',
    op: 'note',
    noteID: 'n1',
    payload: { kind: 'note', text: 'hi' },
  });

  ctx.stub.emitEnd();

  await waitFor(() => {
    expect(applyNote).toHaveBeenCalledOnce();
  });

  recorded.resolve(true);

  await waitFor(() => {
    expect(ctx.stub.isClosed()).toBeTrue();
  });

  expect(ctx.stub.written).toStrictEqual([{ id: 'note:n1', ok: true }]);
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
    version: 1,
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

test('it opens a tap that takes answer notices when the open asks for them', async () => {
  const ctx = setupTest();

  ctx.sessions.set(toSessionID('s1'), {
    id: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    bridgeEpoch: 3,
    state: 'running',
    lastMsg: '',
  });

  const attachTap = mock<BridgeContext['attachTap']>(() => 'ok');

  startSessionBridge(
    ctx.stub.relay,
    {
      sessionID: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('s1'),
      epoch: 3,
    },
    { ...ctx.daemon, attachTap },
  );

  ctx.stub.sendLine({ version: 1, id: 'r1', op: 'tap.open', notices: true });
  ctx.stub.sendLine({ version: 1, id: 'r2', op: 'tap.open' });

  await waitFor(() => {
    expect(ctx.stub.written).toStrictEqual([
      { id: 'r1', ok: true },
      { id: 'r2', ok: true },
    ]);
  });

  expect(attachTap.mock.calls.map((call) => call[2])).toStrictEqual([true, false]);
});

test('it acks an answer notice of its session through the notice ack', async () => {
  const ctx = setupTest();

  ctx.sessions.set(toSessionID('s1'), {
    id: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:a',
    hostKey: toSessionID('s1'),
    bridgeEpoch: 3,
    state: 'running',
    lastMsg: '',
  });

  const ackNotice = mock<BridgeContext['ackNotice']>((_client, sessionID, messageID) =>
    Promise.resolve({
      id: messageID,
      atcID: toSessionID('s2'),
      from: sessionID,
      text: 'run the linter',
      status: 'answered',
      answer: 'the linter is clean',
      sentAt: 0,
      senderSession: sessionID,
      noticeQueuedAt: 1,
      noticeDeliveredAt: 2,
    }),
  );

  startSessionBridge(
    ctx.stub.relay,
    {
      sessionID: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('s1'),
      epoch: 3,
    },
    { ...ctx.daemon, ackNotice },
  );

  ctx.stub.sendLine({ version: 1, id: 'n1', op: 'tap.notice-ack', message: 'm-7' });

  await waitFor(() => {
    expect(ctx.stub.written).toStrictEqual([{ id: 'n1', ok: true, status: 'answered' }]);
  });

  expect(ackNotice.mock.calls.map((call) => [call[1], call[2]])).toStrictEqual([
    [toSessionID('s1'), toMessageID('m-7')],
  ]);
});
