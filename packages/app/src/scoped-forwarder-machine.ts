import { machineTypes } from '@zgeoff/std';
import { setup } from 'xstate';

type ScopedForwarderEvent =
  | { readonly type: 'READ' }
  | { readonly type: 'SETTLE' }
  | { readonly type: 'STOP' };

// A forwarder reads one batch at a time, queues what arrives meanwhile, and
// stops for good once its terminal ends or a read fails. The machine holds
// state only; the forwarder performs every effect.
export const SCOPED_FORWARDER_MACHINE = setup({
  types: machineTypes<{ events: ScopedForwarderEvent }>(),
}).createMachine({
  id: 'scoped-forwarder',
  initial: 'idle',
  states: {
    idle: {
      on: { READ: 'reading', STOP: 'stopped' },
    },
    reading: {
      on: { SETTLE: 'idle', STOP: 'stopped' },
    },
    stopped: {
      type: 'final',
    },
  },
});
