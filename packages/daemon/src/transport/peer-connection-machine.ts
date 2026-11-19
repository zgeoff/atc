import { machineTypes } from '@zgeoff/std';
import { setup } from 'xstate';

type PeerConnectionEvent =
  | { readonly type: 'HELLO' }
  | { readonly type: 'ACCEPT' }
  | { readonly type: 'REFUSE' }
  | { readonly type: 'DRAINED' }
  | { readonly type: 'END' }
  | { readonly type: 'CLOSE' };

export const PEER_CONNECTION_MACHINE = setup({
  types: machineTypes<{ events: PeerConnectionEvent }>(),
  actions: {
    endSocket: () => {},
    releaseConnection: () => {},
  },
}).createMachine({
  id: 'peer-connection',
  initial: 'awaiting',
  states: {
    awaiting: {
      on: { HELLO: 'checking', REFUSE: 'refusing', END: 'closing', CLOSE: 'closed' },
    },
    checking: {
      on: { ACCEPT: 'open', REFUSE: 'refusing', END: 'closing', CLOSE: 'closed' },
    },
    open: {
      on: { END: 'closing', CLOSE: 'closed' },
    },
    refusing: {
      on: { DRAINED: 'closing', END: 'closing', CLOSE: 'closed' },
    },
    closing: {
      entry: 'endSocket',
      on: { CLOSE: 'closed' },
    },
    closed: {
      type: 'final',
      entry: ['endSocket', 'releaseConnection'],
    },
  },
});
