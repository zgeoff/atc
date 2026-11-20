import { machineTypes } from '@zgeoff/std';
import { assign, setup } from 'xstate';

type ClientEvent =
  | { readonly type: 'SUBSCRIBE' }
  | { readonly type: 'CLOSE'; readonly reason: string };

interface ClientContext {
  readonly closedReason: string | null;
}

export const CLIENT_MACHINE = setup({
  types: machineTypes<{ context: ClientContext; events: ClientEvent }>(),
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
