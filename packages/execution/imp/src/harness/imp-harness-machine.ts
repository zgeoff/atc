import type { DaemonError } from '@atc/protocol/wire';
import { machineTypes } from '@zgeoff/std';
import { assign, setup } from 'xstate';

type ImpHarnessEvent =
  | { readonly type: 'CONNECTION_OPENED' }
  | { readonly type: 'CONNECTION_STARTED' }
  | { readonly type: 'CONNECTION_ENDED' }
  | { readonly type: 'START_SENT' }
  | { readonly type: 'FRESH_REQUESTED' }
  | { readonly type: 'KILL_REQUESTED' }
  | { readonly type: 'END'; readonly confirmed: boolean; readonly refusal: DaemonError };

interface ImpHarnessContext {
  // The refusal the harness's start settled with, once it settles that way.
  readonly refusal: DaemonError | null;
}

// Holds state only: the harness performs every effect and reads its state
// back from here.
export const IMP_HARNESS_MACHINE = setup({
  types: machineTypes<{ context: ImpHarnessContext; events: ImpHarnessEvent }>(),
}).createMachine({
  id: 'imp-harness',
  type: 'parallel',
  context: { refusal: null },
  states: {
    run: {
      initial: 'following',
      states: {
        following: {
          type: 'parallel',
          on: {
            END: [
              { guard: (args) => args.event.confirmed, target: 'ended.exited' },
              { target: 'ended.unconfirmed' },
            ],
          },
          states: {
            connection: {
              initial: 'waiting',
              states: {
                waiting: { on: { CONNECTION_STARTED: 'live' } },
                live: { on: { CONNECTION_OPENED: 'waiting', CONNECTION_ENDED: 'waiting' } },
              },
            },
            process: {
              initial: 'unsent',
              states: {
                unsent: { on: { START_SENT: 'sent' } },
                sent: {},
              },
            },
            screen: {
              initial: 'resuming',
              states: {
                resuming: { on: { FRESH_REQUESTED: 'fresh' } },
                fresh: { on: { CONNECTION_STARTED: 'resuming' } },
              },
            },
            kill: {
              initial: 'none',
              states: {
                none: { on: { KILL_REQUESTED: 'pending' } },
                pending: { on: { CONNECTION_STARTED: 'none' } },
              },
            },
          },
        },
        ended: {
          initial: 'unconfirmed',
          states: {
            exited: {},
            unconfirmed: {},
          },
        },
      },
    },
    start: {
      initial: 'pending',
      states: {
        pending: {
          on: {
            CONNECTION_STARTED: 'started',
            END: {
              target: 'refused',
              actions: assign({ refusal: (args) => args.event.refusal }),
            },
          },
        },
        started: {},
        refused: {},
      },
    },
  },
});
