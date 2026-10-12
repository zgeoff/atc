import { expect, test } from 'bun:test';
import { buildStubClock } from '@atc/test-utils/build-stub-clock';
import { waitFor } from '@atc/test-utils/wait-for';
import { waitUntil } from './wait-until';

test('it resolves true without pausing when the condition holds at once', async () => {
  const clock = buildStubClock(1000);

  const result = await waitUntil(() => true, { clock, intervalMs: 100, deadlineMs: 2000 });

  expect(result).toBeTrue();
  expect(clock.collectPending()).toStrictEqual([]);
});

test('it checks again after each interval until the condition holds', async () => {
  const clock = buildStubClock(1000);
  const checkedAt: number[] = [];

  const waited = waitUntil(
    () => {
      checkedAt.push(clock.now());

      return checkedAt.length === 3;
    },
    { clock, intervalMs: 100, deadlineMs: 2000 },
  );

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([100]);
  });

  clock.advance(100);

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([100]);
  });

  clock.advance(100);

  const result = await waited;

  expect(result).toBeTrue();
  expect(checkedAt).toStrictEqual([1000, 1100, 1200]);
});

test('it resolves false once a failing check finds the deadline passed', async () => {
  const clock = buildStubClock(1000);
  const checkedAt: number[] = [];

  const waited = waitUntil(
    () => {
      checkedAt.push(clock.now());

      return false;
    },
    { clock, intervalMs: 100, deadlineMs: 1150 },
  );

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([100]);
  });

  clock.advance(100);

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([100]);
  });

  clock.advance(100);

  const result = await waited;

  expect(result).toBeFalse();
  expect(checkedAt).toStrictEqual([1000, 1100, 1200]);
  expect(clock.collectPending()).toStrictEqual([]);
});

test('it resolves true when the condition holds at the check after the deadline', async () => {
  const clock = buildStubClock(1000);
  let checks = 0;

  const waited = waitUntil(
    () => {
      checks++;

      return clock.now() > 1050;
    },
    { clock, intervalMs: 100, deadlineMs: 1050 },
  );

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([100]);
  });

  clock.advance(100);

  const result = await waited;

  expect(result).toBeTrue();
  expect(checks).toBe(2);
});

test('it awaits a condition that resolves later', async () => {
  const clock = buildStubClock(1000);

  const result = await waitUntil(() => Promise.resolve(true), {
    clock,
    intervalMs: 100,
    deadlineMs: 2000,
  });

  expect(result).toBeTrue();
});

test('it rejects when the condition throws', () => {
  const clock = buildStubClock(1000);

  expect(
    waitUntil(
      () => {
        throw new Error('probe failed');
      },
      { clock, intervalMs: 100, deadlineMs: 2000 },
    ),
  ).rejects.toThrowWithMessage(Error, 'probe failed');
});
