import { createActor } from 'xstate';
import { createPickerMachine } from './create-picker-machine';
import type { SpawnPickerDeps } from './picker-flow';

export interface SpawnPicker {
  readonly open: (resume?: boolean) => void;
  readonly applyKey: (buf: Buffer) => void;
  readonly render: () => void;

  readonly stopFlow: () => void;
}

export function createSpawnPicker<TMirror extends { readonly id: string }>(
  deps: SpawnPickerDeps<TMirror>,
): SpawnPicker {
  const timers = new Map<number, () => void>();

  let nextTimerID = 0;

  const actor = createActor(createPickerMachine(deps), {
    clock: {
      setTimeout: (fire: () => void, timeoutMs: number) => {
        nextTimerID += 1;

        const timerID = nextTimerID;

        timers.set(
          timerID,
          deps.clock.schedule(() => {
            timers.delete(timerID);

            fire();
          }, timeoutMs),
        );

        return timerID;
      },
      clearTimeout: (timerID: number) => {
        timers.get(timerID)?.();
        timers.delete(timerID);
      },
    },
  });

  actor.start();

  return {
    open: (resume = false) => {
      actor.send({ type: 'OPEN', resume });
    },
    applyKey: (buf) => {
      actor.send({ type: 'KEY', buf });
    },
    render: () => {
      actor.send({ type: 'RENDER' });
    },
    stopFlow: () => {
      actor.send({ type: 'STOP' });
    },
  };
}
