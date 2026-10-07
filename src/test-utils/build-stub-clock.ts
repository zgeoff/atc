import type { Clock } from '../shared/system-clock';

interface StubTimer {
  readonly dueAt: number;
  readonly callback: () => void;
}

/**
 * A clock that moves only when the test advances it, for code that takes a
 * clock in place of the wall clock and the runtime's timers. It starts at
 * the given epoch milliseconds. `advance` moves the time forward and runs,
 * in due order, every scheduled callback whose time has come, including
 * one a callback schedules within the step. `collectPending` returns, in
 * due order, how many milliseconds each callback still waiting has left,
 * which lets a test wait until the code under test has scheduled one and
 * check its delay.
 */
export function buildStubClock(startMs: number) {
  let time = startMs;
  let nextID = 0;

  const timers = new Map<number, StubTimer>();

  const findDue = (until: number): [number, StubTimer] | null => {
    let due: [number, StubTimer] | null = null;

    for (const entry of timers) {
      if (entry[1].dueAt <= until && (due === null || entry[1].dueAt < due[1].dueAt)) {
        due = entry;
      }
    }

    return due;
  };

  const clock: Clock = {
    now: () => time,
    schedule: (callback, delayMs) => {
      const id = nextID++;

      timers.set(id, { dueAt: time + Math.max(0, delayMs), callback });

      return () => {
        timers.delete(id);
      };
    },
  };

  return {
    ...clock,
    advance(ms: number): void {
      const until = time + ms;

      for (let due = findDue(until); due !== null; due = findDue(until)) {
        timers.delete(due[0]);

        time = due[1].dueAt;

        due[1].callback();
      }

      time = until;
    },
    collectPending: (): number[] =>
      [...timers.values()].map((timer) => timer.dueAt - time).toSorted((a, b) => a - b),
  };
}
