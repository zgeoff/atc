import { expect, test } from 'bun:test';
import { waitFor } from './wait-for';

test('it returns the value of an attempt that succeeds at once', async () => {
  const value = await waitFor(() => 42);

  expect(value).toBe(42);
});

test('it retries until the attempt stops throwing and resolves with its value', async () => {
  let ready = false;

  setTimeout(() => {
    ready = true;
  }, 60);

  const value = await waitFor(() => {
    if (!ready) {
      throw new Error('not ready yet');
    }

    return 'done';
  });

  expect(value).toBe('done');
});

test('it rethrows the attempt final failure once the deadline passes', () => {
  let attempts = 0;

  const wait = waitFor(
    () => {
      attempts++;
      throw new Error(`attempt ${attempts} failed`);
    },
    { intervalMs: 10, timeoutMs: 80 },
  );

  expect(wait).rejects.toThrowWithMessage(Error, /^attempt \d+ failed$/);
});
