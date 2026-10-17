import { assign, setup } from 'xstate';

export type TransportReconnect = 'on-demand' | 'always';

type TransportEvent =
  | { readonly type: 'CONNECT' }
  | { readonly type: 'OPENED' }
  | { readonly type: 'OPEN_FAILED'; readonly fatal: boolean }
  | { readonly type: 'LOST' }
  | { readonly type: 'RETRY' }
  | { readonly type: 'STOP' };

interface TransportContext {
  readonly reconnect: TransportReconnect;

  // How many opens in a row failed or were lost before they settled into a
  // ready connection, which picks the next backoff.
  readonly failures: number;
}

// holds state only: the transport performs every effect and reads its
// state back from here
export const TRANSPORT_MACHINE = setup({
  types: {
    // oxlint-disable-next-line no-unsafe-type-assertion -- xstate's typed-setup contract: this value is never read, it only carries the context type past the type layer
    context: {} as TransportContext,

    // oxlint-disable-next-line no-unsafe-type-assertion -- xstate's typed-setup contract: this value is never read, it only carries the event union past the type layer
    events: {} as TransportEvent,

    // oxlint-disable-next-line no-unsafe-type-assertion -- xstate's typed-setup contract: this value is never read, it only carries the input type past the type layer
    input: {} as { readonly reconnect: TransportReconnect },
  },
  guards: {
    isAlways: (args) => args.context.reconnect === 'always',
    isFatal: (args) => args.event.type === 'OPEN_FAILED' && args.event.fatal,
  },
  actions: {
    countFailure: assign({ failures: (args) => args.context.failures + 1 }),
    resetFailures: assign({ failures: 0 }),
  },
}).createMachine({
  id: 'transport',
  initial: 'idle',
  context: (args) => ({ reconnect: args.input.reconnect, failures: 0 }),
  on: { STOP: '.closed' },
  states: {
    idle: { on: { CONNECT: 'connecting' } },
    connecting: {
      on: {
        OPENED: { target: 'ready', actions: 'resetFailures' },
        OPEN_FAILED: [
          { guard: 'isFatal', target: 'closed' },
          { guard: 'isAlways', target: 'backoff', actions: 'countFailure' },
          { target: 'idle' },
        ],
      },
    },
    ready: {
      on: {
        LOST: [{ guard: 'isAlways', target: 'backoff' }, { target: 'idle' }],
      },
    },
    backoff: { on: { RETRY: 'connecting' } },
    closed: { type: 'final' },
  },
});
