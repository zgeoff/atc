import { expect, mock, test } from 'bun:test';
import { buildStubTimeoutScheduler } from './build-stub-timeout-scheduler';

test('it runs no timer on its own', () => {
  const scheduler = buildStubTimeoutScheduler();
  const onTimeout = mock(() => {});

  scheduler.schedule(onTimeout, 0);

  expect(onTimeout).not.toHaveBeenCalled();
});

test('it runs the pending timer of the given delay', () => {
  const scheduler = buildStubTimeoutScheduler();
  const onTimeout = mock(() => {});

  scheduler.schedule(onTimeout, 300);
  scheduler.runTimer(300);

  expect(onTimeout).toHaveBeenCalledOnce();
});

test('it runs only the oldest pending timer of the delay', () => {
  const scheduler = buildStubTimeoutScheduler();
  const first = mock(() => {});
  const second = mock(() => {});

  scheduler.schedule(first, 300);
  scheduler.schedule(second, 300);
  scheduler.runTimer(300);

  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
});

test('it refuses to run a delay no pending timer has', () => {
  const scheduler = buildStubTimeoutScheduler();

  scheduler.schedule(() => {}, 300);

  expect(() => {
    scheduler.runTimer(500);
  }).toThrowWithMessage(Error, 'no pending timer of 500 ms');
});

test('it refuses to run a cancelled timer', () => {
  const scheduler = buildStubTimeoutScheduler();
  const cancel = scheduler.schedule(() => {}, 300);

  cancel();

  expect(() => {
    scheduler.runTimer(300);
  }).toThrowWithMessage(Error, 'no pending timer of 300 ms');
});

test('it refuses to run a timer a second time', () => {
  const scheduler = buildStubTimeoutScheduler();

  scheduler.schedule(() => {}, 300);
  scheduler.runTimer(300);

  expect(() => {
    scheduler.runTimer(300);
  }).toThrowWithMessage(Error, 'no pending timer of 300 ms');
});

test('it collects every delay in the order the timers started', () => {
  const scheduler = buildStubTimeoutScheduler();

  scheduler.schedule(() => {}, 10_000);
  scheduler.schedule(() => {}, 500)();
  scheduler.schedule(() => {}, 2000);

  expect(scheduler.collectDelays()).toStrictEqual([10_000, 500, 2000]);
});

test('it collects the delays of the timers neither run nor cancelled', () => {
  const scheduler = buildStubTimeoutScheduler();

  scheduler.schedule(() => {}, 10_000)();
  scheduler.schedule(() => {}, 500);
  scheduler.schedule(() => {}, 2000);
  scheduler.runTimer(500);

  expect(scheduler.collectPendingDelays()).toStrictEqual([2000]);
});

test('it keeps a timer that already ran as run when it is cancelled after', () => {
  const scheduler = buildStubTimeoutScheduler();
  const cancel = scheduler.schedule(() => {}, 300);

  scheduler.runTimer(300);

  cancel();

  expect(scheduler.collectPendingDelays()).toStrictEqual([]);
});
