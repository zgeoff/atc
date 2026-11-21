import { expect, test } from 'bun:test';
import { buildStubClock } from './build-stub-clock';

test('it runs a callback once the clock advances past its delay', () => {
  const clock = buildStubClock(1000);
  const calls: number[] = [];

  clock.schedule(() => {
    calls.push(clock.now());
  }, 100);

  clock.advance(250);

  expect({ calls, now: clock.now() }).toStrictEqual({ calls: [1100], now: 1250 });
});

test('it collects the time left on each callback still waiting in due order', () => {
  const clock = buildStubClock(0);

  clock.schedule(() => {}, 500);
  clock.schedule(() => {}, 100);
  clock.schedule(() => {}, 300);
  clock.advance(200);

  expect(clock.collectPending()).toStrictEqual([100, 300]);
});

test('it collects the delay of every callback scheduled in the order it was scheduled', () => {
  const clock = buildStubClock(0);

  clock.schedule(() => {}, 500);

  const cancel = clock.schedule(() => {}, 100);

  clock.schedule(() => {}, 300);

  cancel();

  clock.advance(400);

  expect(clock.collectDelays()).toStrictEqual([500, 100, 300]);
});

test('it leaves the other waiting callbacks alone when a callback that ran is cancelled', () => {
  const clock = buildStubClock(0);
  const cancel = clock.schedule(() => {}, 100);

  clock.advance(100);
  clock.schedule(() => {}, 50);

  cancel();

  expect(clock.collectPending()).toStrictEqual([50]);
});

test('it runs a callback that fell due during a stall late, at the stalled time', () => {
  const clock = buildStubClock(0);
  const calls: number[] = [];

  clock.schedule(() => {
    calls.push(clock.now());
  }, 100);

  clock.stall(150);
  clock.advance(0);

  expect(calls).toStrictEqual([150]);
});
