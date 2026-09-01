import { expect, test } from 'bun:test';
import { waitForCondition } from './wait-for-condition';

test('it returns at once for a condition that already holds', async () => {
  await expect(waitForCondition(() => true)).toResolve();
});

test('it keeps polling until the condition starts to hold', async () => {
  let done = false;
  const pending = waitForCondition(() => done);

  // A poll observing the unmet condition leaves no signal; the settle spans
  // a few poll rounds so the wait proves polling, not a single check.
  await Bun.sleep(40);

  done = true;

  await expect(pending).toResolve();
});

test('it throws when the deadline passes first', () => {
  expect(waitForCondition(() => false, 100)).rejects.toThrowWithMessage(
    Error,
    'timed out waiting for the condition',
  );
});
