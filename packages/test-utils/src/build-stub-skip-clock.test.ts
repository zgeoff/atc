import { expect, test } from 'bun:test';
import { buildStubSkipClock } from './build-stub-skip-clock';

test('it starts at zero', () => {
  expect(buildStubSkipClock().now()).toBe(0);
});

test('it moves the time to when a callback was due as the callback runs', async () => {
  const clock = buildStubSkipClock();
  const seen: number[] = [];
  const ran = Promise.withResolvers<void>();

  clock.schedule(() => {
    seen.push(clock.now());

    clock.schedule(() => {
      seen.push(clock.now());
      ran.resolve();
    }, 250);
  }, 10_000);

  await ran.promise;

  expect(seen).toStrictEqual([10_000, 10_250]);
});

test('it never runs a cancelled callback nor moves the time for it', async () => {
  const clock = buildStubSkipClock();
  const ran = Promise.withResolvers<void>();
  let cancelledRan = false;

  const cancel = clock.schedule(() => {
    cancelledRan = true;
  }, 5000);

  cancel();

  clock.schedule(ran.resolve, 0);

  await ran.promise;

  expect(cancelledRan).toBeFalse();
  expect(clock.now()).toBe(0);
});
