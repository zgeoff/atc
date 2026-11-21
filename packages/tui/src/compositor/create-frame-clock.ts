import type { Clock } from '@atc/core';
import { isLateTick, pickNextFrameAt } from './pick-next-frame-at';
import type { Layer } from './types';

const FRAME_MS = 16;

export interface FrameClockDeps {
  readonly clock: Clock;

  // false turns decorative motion off; a layer reads it when it builds its next-frame answer
  readonly animations: boolean;
  readonly collectLayers: () => readonly Layer[];
  readonly drawFrame: () => void;
}

export interface FrameClock {
  readonly animations: boolean;

  // an event needs a frame now: a session wrote, a key arrived, the fleet changed, the window resized
  readonly request: () => void;
  readonly stop: () => void;
}

interface PendingFrame {
  readonly dueAtMs: number;
  readonly isTick: boolean;
  readonly cancel: () => void;
}

export function createFrameClock(deps: FrameClockDeps): FrameClock {
  let pending: PendingFrame | null = null;
  let isStopped = false;

  const schedule = (dueAtMs: number, isTick: boolean): void => {
    const delay = Math.max(0, dueAtMs - deps.clock.now());

    pending = { dueAtMs, isTick, cancel: deps.clock.schedule(runFrame, delay) };
  };

  const runFrame = (): void => {
    const frame = pending;

    pending = null;

    if (isStopped || frame === null) {
      return;
    }

    if (!(frame.isTick && isLateTick(frame.dueAtMs, deps.clock.now(), FRAME_MS))) {
      deps.drawFrame();
    }

    const nowMs = deps.clock.now();
    const next = pickNextFrameAt(deps.collectLayers().map((layer) => layer.nextFrameAt(nowMs)));

    if (next !== null && pending === null) {
      schedule(next, true);
    }
  };

  return {
    animations: deps.animations,
    request: () => {
      if (isStopped) {
        return;
      }

      const nowMs = deps.clock.now();

      if (pending !== null) {
        if (pending.dueAtMs <= nowMs) {
          return;
        }

        pending.cancel();
      }

      schedule(nowMs, false);
    },

    stop: () => {
      isStopped = true;
      pending?.cancel();
      pending = null;
    },
  };
}
