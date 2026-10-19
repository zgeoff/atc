import { expect, onTestFinished, test } from 'bun:test';
import { createActor } from 'xstate';
import { EVENT_FEED_MACHINE } from './event-feed-machine';

function setupTest() {
  const actor = createActor(EVENT_FEED_MACHINE).start();

  onTestFinished(() => {
    actor.stop();
  });

  return { actor };
}

test('it starts collecting', () => {
  const ctx = setupTest();

  expect(ctx.actor.getSnapshot().value).toBe('collecting');
});

test.each([
  ['collecting', [], 'OVERFLOW', 'abandoned'],
  ['collecting', [], 'SUBSCRIBE', 'subscribed'],
  ['collecting', [], 'UNSUBSCRIBE', 'collecting'],
  ['abandoned', ['OVERFLOW'], 'OVERFLOW', 'abandoned'],
  ['abandoned', ['OVERFLOW'], 'SUBSCRIBE', 'subscribed'],
  ['abandoned', ['OVERFLOW'], 'UNSUBSCRIBE', 'abandoned'],
  ['subscribed', ['SUBSCRIBE'], 'OVERFLOW', 'subscribed'],
  ['subscribed', ['SUBSCRIBE'], 'SUBSCRIBE', 'subscribed'],
  ['subscribed', ['SUBSCRIBE'], 'UNSUBSCRIBE', 'collecting'],
] as const)(
  'it moves a %s feed, reached through %p, on %s to %s',
  (_from, before, event, expected) => {
    const ctx = setupTest();

    for (const type of before) {
      ctx.actor.send({ type });
    }

    ctx.actor.send({ type: event });

    expect(ctx.actor.getSnapshot().value).toBe(expected);
  },
);
