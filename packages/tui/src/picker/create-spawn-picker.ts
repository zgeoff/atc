import { toTimerClock } from '@atc/core';
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
  const actor = createActor(createPickerMachine(deps), { clock: toTimerClock(deps.clock) });

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
