import { expect, onTestFinished, test } from 'bun:test';
import { createActor } from 'xstate';
import { CLIENT_MACHINE } from './client-machine';

function setupTest() {
  const actor = createActor(CLIENT_MACHINE).start();

  onTestFinished(() => {
    actor.stop();
  });

  return { actor };
}

test('it starts open and quiet, with no reason to close', () => {
  const ctx = setupTest();

  expect(ctx.actor.getSnapshot().value).toStrictEqual({ open: 'quiet' });
  expect(ctx.actor.getSnapshot().context.closedReason).toBeNull();
});

test('it is subscribed once its subscription starts', () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'SUBSCRIBE' });

  expect(ctx.actor.getSnapshot().value).toStrictEqual({ open: 'subscribed' });
});

test('it closes with the reason given from either open state', () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'SUBSCRIBE' });
  ctx.actor.send({ type: 'CLOSE', reason: 'connection closed' });

  expect(ctx.actor.getSnapshot().value).toBe('closed');
  expect(ctx.actor.getSnapshot().context.closedReason).toBe('connection closed');
});

test('it keeps the first reason once closed', () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'CLOSE', reason: 'client closed' });
  ctx.actor.send({ type: 'CLOSE', reason: 'connection closed' });

  expect(ctx.actor.getSnapshot().context.closedReason).toBe('client closed');
});

test('it starts no subscription once closed', () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'CLOSE', reason: 'client closed' });
  ctx.actor.send({ type: 'SUBSCRIBE' });

  expect(ctx.actor.getSnapshot().value).toBe('closed');
});
