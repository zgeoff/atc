import { expect, test } from 'bun:test';
import { buildStubWaitClock } from './build-stub-wait-clock';

test('it starts at zero', () => {
  expect(buildStubWaitClock().now()).toBe(0);
});

test('it moves the time by each wait', async () => {
  const clock = buildStubWaitClock();

  await clock.wait(15);
  await clock.wait(20);

  expect(clock.now()).toBe(35);
});

test('it records the milliseconds of each wait in order', async () => {
  const clock = buildStubWaitClock();

  await clock.wait(15);
  await clock.wait(20);

  expect(clock.waits).toStrictEqual([15, 20]);
});
