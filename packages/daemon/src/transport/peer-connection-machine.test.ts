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
  { from: 'awaiting', before: [], event: 'HELLO', to: 'checking', ends: 0, releases: 0 },
  { from: 'awaiting', before: [], event: 'ACCEPT', to: 'awaiting', ends: 0, releases: 0 },
  { from: 'awaiting', before: [], event: 'REFUSE', to: 'refusing', ends: 0, releases: 0 },
  { from: 'awaiting', before: [], event: 'DRAINED', to: 'awaiting', ends: 0, releases: 0 },
  { from: 'awaiting', before: [], event: 'END', to: 'closing', ends: 1, releases: 0 },
  { from: 'awaiting', before: [], event: 'CLOSE', to: 'closed', ends: 1, releases: 1 },
  { from: 'checking', before: ['HELLO'], event: 'HELLO', to: 'checking', ends: 0, releases: 0 },
  { from: 'checking', before: ['HELLO'], event: 'ACCEPT', to: 'open', ends: 0, releases: 0 },
  { from: 'checking', before: ['HELLO'], event: 'REFUSE', to: 'refusing', ends: 0, releases: 0 },
  { from: 'checking', before: ['HELLO'], event: 'DRAINED', to: 'checking', ends: 0, releases: 0 },
  { from: 'checking', before: ['HELLO'], event: 'END', to: 'closing', ends: 1, releases: 0 },
  { from: 'checking', before: ['HELLO'], event: 'CLOSE', to: 'closed', ends: 1, releases: 1 },
  { from: 'open', before: ['HELLO', 'ACCEPT'], event: 'HELLO', to: 'open', ends: 0, releases: 0 },
  { from: 'open', before: ['HELLO', 'ACCEPT'], event: 'ACCEPT', to: 'open', ends: 0, releases: 0 },
  { from: 'open', before: ['HELLO', 'ACCEPT'], event: 'REFUSE', to: 'open', ends: 0, releases: 0 },
  { from: 'open', before: ['HELLO', 'ACCEPT'], event: 'DRAINED', to: 'open', ends: 0, releases: 0 },
  { from: 'open', before: ['HELLO', 'ACCEPT'], event: 'END', to: 'closing', ends: 1, releases: 0 },
  { from: 'open', before: ['HELLO', 'ACCEPT'], event: 'CLOSE', to: 'closed', ends: 1, releases: 1 },
  { from: 'refusing', before: ['REFUSE'], event: 'HELLO', to: 'refusing', ends: 0, releases: 0 },
  { from: 'refusing', before: ['REFUSE'], event: 'ACCEPT', to: 'refusing', ends: 0, releases: 0 },
  { from: 'refusing', before: ['REFUSE'], event: 'REFUSE', to: 'refusing', ends: 0, releases: 0 },
  { from: 'refusing', before: ['REFUSE'], event: 'DRAINED', to: 'closing', ends: 1, releases: 0 },
  { from: 'refusing', before: ['REFUSE'], event: 'END', to: 'closing', ends: 1, releases: 0 },
  { from: 'refusing', before: ['REFUSE'], event: 'CLOSE', to: 'closed', ends: 1, releases: 1 },
  { from: 'closing', before: ['END'], event: 'HELLO', to: 'closing', ends: 1, releases: 0 },
  { from: 'closing', before: ['END'], event: 'ACCEPT', to: 'closing', ends: 1, releases: 0 },
  { from: 'closing', before: ['END'], event: 'REFUSE', to: 'closing', ends: 1, releases: 0 },
  { from: 'closing', before: ['END'], event: 'DRAINED', to: 'closing', ends: 1, releases: 0 },
  { from: 'closing', before: ['END'], event: 'END', to: 'closing', ends: 1, releases: 0 },
  { from: 'closing', before: ['END'], event: 'CLOSE', to: 'closed', ends: 2, releases: 1 },
  { from: 'closed', before: ['CLOSE'], event: 'HELLO', to: 'closed', ends: 1, releases: 1 },
  { from: 'closed', before: ['CLOSE'], event: 'ACCEPT', to: 'closed', ends: 1, releases: 1 },
  { from: 'closed', before: ['CLOSE'], event: 'REFUSE', to: 'closed', ends: 1, releases: 1 },
  { from: 'closed', before: ['CLOSE'], event: 'DRAINED', to: 'closed', ends: 1, releases: 1 },
  { from: 'closed', before: ['CLOSE'], event: 'END', to: 'closed', ends: 1, releases: 1 },
  { from: 'closed', before: ['CLOSE'], event: 'CLOSE', to: 'closed', ends: 1, releases: 1 },
] as const)(
  'it moves a $from connection, reached through $before, on $event to $to, having ended its socket $ends times and released it $releases times',
  (row) => {
    const ctx = setupTest();

    for (const type of row.before) {
      ctx.actor.send({ type });
    }

    ctx.actor.send({ type: row.event });

    expect(ctx.actor.getSnapshot().value).toBe(row.to);
    expect(ctx.endSocket).toHaveBeenCalledTimes(row.ends);
    expect(ctx.releaseConnection).toHaveBeenCalledTimes(row.releases);
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
