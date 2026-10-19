import { assign, setup } from 'xstate';

type ClientEvent =
  | { readonly type: 'SUBSCRIBE' }
  | { readonly type: 'CLOSE'; readonly reason: string };

interface ClientContext {
  // Why the connection ended: the first reason given, kept once closed.
  readonly closedReason: string | null;
}

// A daemon client's connection: open until it ends, and quiet until its one
// event subscription starts. It holds state only; the client performs every
// effect and reads its state back from here.
export const CLIENT_MACHINE = setup({
  types: {
    // oxlint-disable-next-line no-unsafe-type-assertion -- xstate's typed-setup contract: this value is never read, it only carries the context type past the type layer
    context: {} as ClientContext,

    // oxlint-disable-next-line no-unsafe-type-assertion -- xstate's typed-setup contract: this value is never read, it only carries the event union past the type layer
    events: {} as ClientEvent,
  },
  actions: {
    recordReason: assign({
      closedReason: (args) => (args.event.type === 'CLOSE' ? args.event.reason : null),
    }),
  },
}).createMachine({
  id: 'daemon-client',
  initial: 'open',
  context: { closedReason: null },
  states: {
    open: {
      initial: 'quiet',
      on: { CLOSE: { target: 'closed', actions: 'recordReason' } },
      states: {
        quiet: { on: { SUBSCRIBE: 'subscribed' } },
        subscribed: {},
      },
    },
    closed: { type: 'final' },
  },
});
