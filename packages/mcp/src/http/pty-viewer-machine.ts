import { machineTypes } from '@zgeoff/std';
import { setup } from 'xstate';

type PTYViewerEvent =
  | { readonly type: 'OPEN' }
  | { readonly type: 'STALL' }
  | { readonly type: 'DRAIN' }
  | { readonly type: 'RESYNC' }
  | { readonly type: 'SNAPSHOT' }
  | { readonly type: 'CLOSE' };

// A viewer holds output back until its socket opens and while a snapshot is
// on its way, and drops output while the browser lags. The machine holds
// state only; the viewer performs every effect.
export const PTY_VIEWER_MACHINE = setup({
  types: machineTypes<{ events: PTYViewerEvent }>(),
}).createMachine({
  id: 'pty-viewer',
  initial: 'opening',
  states: {
    opening: {
      on: { OPEN: 'streaming', CLOSE: 'closed' },
    },
    streaming: {
      on: { STALL: 'stalled', RESYNC: 'resyncing', CLOSE: 'closed' },
    },
    stalled: {
      on: { DRAIN: 'resyncing', CLOSE: 'closed' },
    },
    resyncing: {
      on: { SNAPSHOT: 'streaming', STALL: 'stalled', CLOSE: 'closed' },
    },
    closed: {
      type: 'final',
    },
  },
});
