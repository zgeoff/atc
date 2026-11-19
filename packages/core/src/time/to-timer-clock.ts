import type { Clock } from './system-clock';

// The clock shape xstate's actors take, which names each timer by an id.
export interface TimerClock {
  readonly setTimeout: (callback: () => void, timeout: number) => number;
  readonly clearTimeout: (timerID: number) => void;
}

// xstate's clock takes a timer id, and a Clock hands back a cancel, so the
// adapter keeps the cancel of each pending timer under its id.
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
