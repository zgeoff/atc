import { expect, mock, test } from 'bun:test';
import { buildStubClock } from '@atc/test-utils';
import { toTimerClock } from './to-timer-clock';

test('it runs a timer once the clock reaches its delay', () => {
  const clock = buildStubClock(0);
  const callback = mock<() => void>();

  toTimerClock(clock).setTimeout(callback, 1000);

  clock.advance(1000);

  expect(callback).toHaveBeenCalledOnce();
});

test('it never runs a timer cleared before its delay', () => {
  const clock = buildStubClock(0);
  const callback = mock<() => void>();
  const timers = toTimerClock(clock);
  const timerID = timers.setTimeout(callback, 1000);

  timers.clearTimeout(timerID);
  clock.advance(1000);

  expect(callback).not.toHaveBeenCalled();
  expect(clock.collectPending()).toStrictEqual([]);
});

test('it clears only the timer whose id it gets', () => {
  const clock = buildStubClock(0);
  const cleared = mock<() => void>();
  const kept = mock<() => void>();
  const timers = toTimerClock(clock);
  const clearedID = timers.setTimeout(cleared, 1000);

  timers.setTimeout(kept, 1000);
  timers.clearTimeout(clearedID);
  clock.advance(1000);

  expect(cleared).not.toHaveBeenCalled();
  expect(kept).toHaveBeenCalledOnce();
});
