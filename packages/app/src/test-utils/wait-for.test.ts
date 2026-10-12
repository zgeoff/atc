import { expect, test } from 'bun:test';
import { buildStubWaitClock } from './build-stub-wait-clock';
import { waitFor } from './wait-for';

// A clock that moves only when a wait waits it out, so a deadline passes
// after a known number of attempts.
function setupTest() {
  return buildStubWaitClock();
}

test('it returns the value of an attempt that succeeds at once', async () => {
  const value = await waitFor(() => 42);

  expect(value).toBe(42);
});

test('it retries until the attempt stops throwing and resolves with its value', async () => {
  const ctx = setupTest();
  let attempts = 0;

  const value = await waitFor(
    () => {
      attempts++;

      if (attempts < 3) {
        throw new Error('not ready yet');
      }

      return 'done';
    },
    { now: ctx.now, wait: ctx.wait },
  );

  expect(value).toBe('done');
  expect(attempts).toBe(3);
});

test('it waits the given interval between attempts', async () => {
  const ctx = setupTest();
  let attempts = 0;

  await waitFor(
    () => {
      attempts++;

      if (attempts < 3) {
        throw new Error('not ready yet');
      }
    },
    { intervalMs: 15, now: ctx.now, wait: ctx.wait },
  );

  expect(ctx.waits).toStrictEqual([15, 15]);
});

test('it rethrows the attempt final failure once the deadline passes', () => {
  const ctx = setupTest();
  let attempts = 0;

  const wait = waitFor(
    () => {
      attempts++;
      throw new Error(`attempt ${attempts} failed`);
    },
    { intervalMs: 10, timeoutMs: 80, now: ctx.now, wait: ctx.wait },
  );

  expect(wait).rejects.toThrowWithMessage(Error, 'attempt 9 failed');
});

test('it gives up after five seconds of retries every twenty milliseconds by default', () => {
  const ctx = setupTest();
  let attempts = 0;

  const wait = waitFor(
    () => {
      attempts++;
      throw new Error(`attempt ${attempts} failed`);
    },
    { now: ctx.now, wait: ctx.wait },
  );

  expect(wait).rejects.toThrowWithMessage(Error, 'attempt 251 failed');
});
