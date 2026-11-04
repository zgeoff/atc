import { expect, test } from 'bun:test';
import { buildStubClock } from '@atc/test-utils';
import { makeQueuedAnswers } from './make-queued-answers';

test('it rejects a call whose queued answer is a refusal', () => {
  const answer = makeQueuedAnswers([{ kind: 'refuse', error: new Error('not yet') }]);

  expect(answer()).rejects.toThrow('not yet');
});

test('it resolves a call whose queued answer is a success', () => {
  const answer = makeQueuedAnswers([{ kind: 'succeed' }]);

  expect(answer()).resolves.toBeUndefined();
});

test('it resolves a call whose queued answer is a delayed success once the delay passes', () => {
  const clock = buildStubClock(0);
  const answer = makeQueuedAnswers([{ kind: 'succeed-after', clock, delayMs: 10_000 }]);
  const answered = answer();

  clock.advance(10_000);

  expect(answered).resolves.toBeUndefined();
});

test('it holds a delayed success until its delay passes', () => {
  const clock = buildStubClock(0);
  const answer = makeQueuedAnswers([{ kind: 'succeed-after', clock, delayMs: 10_000 }]);

  void answer();
  expect(clock.collectPending()).toStrictEqual([10_000]);
});

test('it answers each call with the next answer in the queue', async () => {
  const answer = makeQueuedAnswers([
    { kind: 'refuse', error: new Error('not yet') },
    { kind: 'succeed' },
  ]);

  await Promise.allSettled([answer()]);

  expect(answer()).resolves.toBeUndefined();
});

test('it rejects a call after the queue ends', async () => {
  const answer = makeQueuedAnswers([{ kind: 'succeed' }]);

  await answer();

  expect(answer()).rejects.toThrow('the stand-in got a call after its answers ran out');
});
