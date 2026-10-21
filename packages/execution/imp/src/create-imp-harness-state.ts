import type { DaemonError } from '@atc/protocol/wire';
import { createActor } from 'xstate';
import type { EventFrom } from 'xstate';
import { IMP_HARNESS_MACHINE } from './imp-harness-machine';

// The harness's lifecycle: the actor that holds it and the questions the
// harness asks of it.
export interface ImpHarnessState {
  readonly send: (event: EventFrom<typeof IMP_HARNESS_MACHINE>) => void;

  readonly isStarted: () => boolean;

  readonly isDone: () => boolean;

  readonly hasSentStart: () => boolean;

  // Whether the next connection replaces the screen rather than resuming.
  readonly shouldReplaceScreen: () => boolean;

  readonly hasPendingKill: () => boolean;

  // Whether the process exited, once the harness stops being followed;
  // null until then.
  readonly findExitConfirmation: () => boolean | null;

  // How the harness's start settled, or null while it has not.
  readonly findStartOutcome: () => 'started' | Readonly<DaemonError> | null;
}

export function createImpHarnessState(): ImpHarnessState {
  // Whether the open connection started, whether the start went out, how
  // the next connection meets the screen, whether a kill waits, whether the
  // harness ended, and how its start settled.
  const actor = createActor(IMP_HARNESS_MACHINE).start();

  return {
    send: (event) => {
      actor.send(event);
    },

    isStarted: () => actor.getSnapshot().matches({ run: { following: { connection: 'live' } } }),

    isDone: () => actor.getSnapshot().matches({ run: 'ended' }),

    hasSentStart: () => actor.getSnapshot().matches({ run: { following: { process: 'sent' } } }),

    shouldReplaceScreen: () =>
      actor.getSnapshot().matches({ run: { following: { screen: 'fresh' } } }),

    hasPendingKill: () => actor.getSnapshot().matches({ run: { following: { kill: 'pending' } } }),

    findExitConfirmation: () => {
      const snapshot = actor.getSnapshot();

      if (snapshot.matches({ run: { ended: 'exited' } })) {
        return true;
      }

      return snapshot.matches({ run: 'ended' }) ? false : null;
    },

    findStartOutcome: () => {
      const snapshot = actor.getSnapshot();

      if (snapshot.matches({ start: 'started' })) {
        return 'started';
      }

      return snapshot.matches({ start: 'refused' }) ? snapshot.context.refusal : null;
    },
  };
}
