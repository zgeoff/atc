import type { DaemonError } from '@atc/protocol/wire';
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

/**
 * The lifecycle of an imp harness as one statechart, holding state only:
 * the harness performs every effect and reads its state back from here.
 *
 * Two regions run side by side. `run` follows the session until it ends:
 * while following, `connection` holds whether the open connection has started,
 * `process` whether the request that starts the process went out, `screen`
 * whether the next connection replaces the screen, and `kill` whether a
 * kill waits for the next connection to start. A connection that starts
 * resumes the screen and sends the waiting kill. The first `END` stops the
 * following for good, as an exit impd reported or as one nothing confirms.
 *
 * `start` settles once: started by the first connection that starts, or
 * refused by an `END` that comes before one, with the refusal it carries.
 */
export const IMP_HARNESS_MACHINE = setup({
  types: {
    // oxlint-disable-next-line no-unsafe-type-assertion -- xstate's typed-setup contract: this value is never read, it only carries the context type past the type layer
    context: {} as ImpHarnessContext,

    // oxlint-disable-next-line no-unsafe-type-assertion -- xstate's typed-setup contract: this value is never read, it only carries the event union past the type layer
    events: {} as ImpHarnessEvent,
  },
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
