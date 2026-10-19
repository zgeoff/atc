import { expect, mock, onTestFinished, test } from 'bun:test';
import { createActor } from 'xstate';
import { PEER_CONNECTION_MACHINE } from './peer-connection-machine';

function setupTest() {
  const endSocket = mock(() => {});
  const releaseConnection = mock(() => {});

  const actor = createActor(
    PEER_CONNECTION_MACHINE.provide({ actions: { endSocket, releaseConnection } }),
  ).start();

  onTestFinished(() => {
    actor.stop();
  });

  return { actor, endSocket, releaseConnection };
}

test('it starts awaiting the handshake', () => {
  const ctx = setupTest();

  expect(ctx.actor.getSnapshot().value).toBe('awaiting');
});

test.each([
  ['awaiting', [], 'HELLO', 'checking'],
  ['awaiting', [], 'ACCEPT', 'awaiting'],
  ['awaiting', [], 'REFUSE', 'refusing'],
  ['awaiting', [], 'DRAINED', 'awaiting'],
  ['awaiting', [], 'END', 'closing'],
  ['awaiting', [], 'CLOSE', 'closed'],
  ['checking', ['HELLO'], 'HELLO', 'checking'],
  ['checking', ['HELLO'], 'ACCEPT', 'open'],
  ['checking', ['HELLO'], 'REFUSE', 'refusing'],
  ['checking', ['HELLO'], 'DRAINED', 'checking'],
  ['checking', ['HELLO'], 'END', 'closing'],
  ['checking', ['HELLO'], 'CLOSE', 'closed'],
  ['open', ['HELLO', 'ACCEPT'], 'HELLO', 'open'],
  ['open', ['HELLO', 'ACCEPT'], 'ACCEPT', 'open'],
  ['open', ['HELLO', 'ACCEPT'], 'REFUSE', 'open'],
  ['open', ['HELLO', 'ACCEPT'], 'DRAINED', 'open'],
  ['open', ['HELLO', 'ACCEPT'], 'END', 'closing'],
  ['open', ['HELLO', 'ACCEPT'], 'CLOSE', 'closed'],
  ['refusing', ['REFUSE'], 'HELLO', 'refusing'],
  ['refusing', ['REFUSE'], 'ACCEPT', 'refusing'],
  ['refusing', ['REFUSE'], 'REFUSE', 'refusing'],
  ['refusing', ['REFUSE'], 'DRAINED', 'closing'],
  ['refusing', ['REFUSE'], 'END', 'closing'],
  ['refusing', ['REFUSE'], 'CLOSE', 'closed'],
  ['closing', ['END'], 'HELLO', 'closing'],
  ['closing', ['END'], 'ACCEPT', 'closing'],
  ['closing', ['END'], 'REFUSE', 'closing'],
  ['closing', ['END'], 'DRAINED', 'closing'],
  ['closing', ['END'], 'END', 'closing'],
  ['closing', ['END'], 'CLOSE', 'closed'],
  ['closed', ['CLOSE'], 'HELLO', 'closed'],
  ['closed', ['CLOSE'], 'ACCEPT', 'closed'],
  ['closed', ['CLOSE'], 'REFUSE', 'closed'],
  ['closed', ['CLOSE'], 'DRAINED', 'closed'],
  ['closed', ['CLOSE'], 'END', 'closed'],
  ['closed', ['CLOSE'], 'CLOSE', 'closed'],
] as const)(
  'it moves a %s connection, reached through %p, on %s to %s',
  (_from, before, event, expected) => {
    const ctx = setupTest();

    for (const type of before) {
      ctx.actor.send({ type });
    }

    ctx.actor.send({ type: event });

    expect(ctx.actor.getSnapshot().value).toBe(expected);
  },
);

test('it ends the socket once on the way to closing', () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'REFUSE' });
  ctx.actor.send({ type: 'DRAINED' });

  expect(ctx.endSocket).toHaveBeenCalledOnce();
  expect(ctx.releaseConnection).not.toHaveBeenCalled();
});

test('it ends the socket and releases the connection once closed', () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'CLOSE' });

  expect(ctx.endSocket).toHaveBeenCalledOnce();
  expect(ctx.releaseConnection).toHaveBeenCalledOnce();
});
