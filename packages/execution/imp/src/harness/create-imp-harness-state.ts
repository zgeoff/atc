import type { DaemonError } from '@atc/protocol/wire';
import { createActor } from 'xstate';
import type { EventFrom } from 'xstate';
import { IMP_HARNESS_MACHINE } from './imp-harness-machine';

export interface ImpHarnessState {
  readonly send: (event: EventFrom<typeof IMP_HARNESS_MACHINE>) => void;

  readonly isStarted: () => boolean;

  readonly isDone: () => boolean;

  readonly hasSentStart: () => boolean;

  readonly shouldReplaceScreen: () => boolean;

  readonly hasPendingKill: () => boolean;

  readonly findExitConfirmation: () => boolean | null;

  readonly findStartOutcome: () => 'started' | Readonly<DaemonError> | null;
}

export function createImpHarnessState(): ImpHarnessState {
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
