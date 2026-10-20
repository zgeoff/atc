import type { Clock } from '@atc/core';

interface StubTimer {
  readonly dueAt: number;
  readonly callback: () => void;
}

export function buildStubClock(startMs: number) {
  let time = startMs;
  let nextID = 0;

  const timers = new Map<number, StubTimer>();

  const delays: number[] = [];

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

      delays.push(delayMs);
      timers.set(id, { dueAt: time + Math.max(0, delayMs), callback });

      return () => {
        timers.delete(id);
      };
    },
  };

  return {
    ...clock,
    advance(durationMs: number): void {
      const until = time + durationMs;

      for (let due = findDue(until); due !== null; due = findDue(until)) {
        timers.delete(due[0]);

        time = due[1].dueAt;

        due[1].callback();
      }

      time = until;
    },
    collectPending: (): number[] =>
      [...timers.values()]
        .map((timer) => timer.dueAt - time)
        .toSorted((left, right) => left - right),
    collectDelays: (): number[] => [...delays],
  };
}
