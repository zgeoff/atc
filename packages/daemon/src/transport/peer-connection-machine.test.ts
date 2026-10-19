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
  ['awaiting', [], 'HELLO', 'checking', 0, 0],
  ['awaiting', [], 'ACCEPT', 'awaiting', 0, 0],
  ['awaiting', [], 'REFUSE', 'refusing', 0, 0],
  ['awaiting', [], 'DRAINED', 'awaiting', 0, 0],
  ['awaiting', [], 'END', 'closing', 1, 0],
  ['awaiting', [], 'CLOSE', 'closed', 1, 1],
  ['checking', ['HELLO'], 'HELLO', 'checking', 0, 0],
  ['checking', ['HELLO'], 'ACCEPT', 'open', 0, 0],
  ['checking', ['HELLO'], 'REFUSE', 'refusing', 0, 0],
  ['checking', ['HELLO'], 'DRAINED', 'checking', 0, 0],
  ['checking', ['HELLO'], 'END', 'closing', 1, 0],
  ['checking', ['HELLO'], 'CLOSE', 'closed', 1, 1],
  ['open', ['HELLO', 'ACCEPT'], 'HELLO', 'open', 0, 0],
  ['open', ['HELLO', 'ACCEPT'], 'ACCEPT', 'open', 0, 0],
  ['open', ['HELLO', 'ACCEPT'], 'REFUSE', 'open', 0, 0],
  ['open', ['HELLO', 'ACCEPT'], 'DRAINED', 'open', 0, 0],
  ['open', ['HELLO', 'ACCEPT'], 'END', 'closing', 1, 0],
  ['open', ['HELLO', 'ACCEPT'], 'CLOSE', 'closed', 1, 1],
  ['refusing', ['REFUSE'], 'HELLO', 'refusing', 0, 0],
  ['refusing', ['REFUSE'], 'ACCEPT', 'refusing', 0, 0],
  ['refusing', ['REFUSE'], 'REFUSE', 'refusing', 0, 0],
  ['refusing', ['REFUSE'], 'DRAINED', 'closing', 1, 0],
  ['refusing', ['REFUSE'], 'END', 'closing', 1, 0],
  ['refusing', ['REFUSE'], 'CLOSE', 'closed', 1, 1],
  ['closing', ['END'], 'HELLO', 'closing', 1, 0],
  ['closing', ['END'], 'ACCEPT', 'closing', 1, 0],
  ['closing', ['END'], 'REFUSE', 'closing', 1, 0],
  ['closing', ['END'], 'DRAINED', 'closing', 1, 0],
  ['closing', ['END'], 'END', 'closing', 1, 0],
  ['closing', ['END'], 'CLOSE', 'closed', 2, 1],
  ['closed', ['CLOSE'], 'HELLO', 'closed', 1, 1],
  ['closed', ['CLOSE'], 'ACCEPT', 'closed', 1, 1],
  ['closed', ['CLOSE'], 'REFUSE', 'closed', 1, 1],
  ['closed', ['CLOSE'], 'DRAINED', 'closed', 1, 1],
  ['closed', ['CLOSE'], 'END', 'closed', 1, 1],
  ['closed', ['CLOSE'], 'CLOSE', 'closed', 1, 1],
] as const)(
  'it moves a %s connection, reached through %p, on %s to %s, having ended its socket %d times and released it %d times',
  (_from, before, event, expected, ends, releases) => {
    const ctx = setupTest();

    for (const type of before) {
      ctx.actor.send({ type });
    }

    ctx.actor.send({ type: event });

    expect(ctx.actor.getSnapshot().value).toBe(expected);
    expect(ctx.endSocket).toHaveBeenCalledTimes(ends);
    expect(ctx.releaseConnection).toHaveBeenCalledTimes(releases);
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
