import { toTimerClock } from '@atc/core';
import { createActor } from 'xstate';
import type { DaemonName } from '../session-key';
import { createPickerMachine } from './create-picker-machine';
import type { SpawnPickerDeps } from './picker-flow';

export interface SpawnPicker {
  readonly open: (resume?: boolean) => void;
  readonly applyKey: (buf: Buffer) => void;
  readonly render: () => void;

  readonly stopFlow: () => void;

  // True while the flow runs against the daemon: open, and past the daemon step.
  readonly isOpenOn: (daemon: DaemonName) => boolean;
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
    isOpenOn: (daemon) => {
      const snapshot = actor.getSnapshot();

      return (
        snapshot.matches('open') &&
        snapshot.context.step !== 'daemon' &&
        snapshot.context.daemon === daemon
      );
    },
  };
}
