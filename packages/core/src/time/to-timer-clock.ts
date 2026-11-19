import type { Clock } from './system-clock';

// The clock shape xstate's actors take.
export interface TimerClock {
  readonly setTimeout: (callback: () => void, timeout: number) => number;
  readonly clearTimeout: (timerID: number) => void;
}

// xstate clears a timer by the id that setTimeout returned, but our scheduler returns a cancel
// function instead, so each pending timer's cancel is kept under its id.
export function toTimerClock(clock: Clock): TimerClock {
  const cancels = new Map<number, () => void>();

  let nextTimerID = 0;

  return {
    setTimeout: (fire, timeout) => {
      const timerID = nextTimerID++;

      cancels.set(
        timerID,
        clock.schedule(() => {
          cancels.delete(timerID);

          fire();
        }, timeout),
      );

      return timerID;
    },
    clearTimeout: (timerID) => {
      cancels.get(timerID)?.();
      cancels.delete(timerID);
    },
  };
}
