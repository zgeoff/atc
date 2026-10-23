import { machineTypes } from '@zgeoff/std';
import { assign, setup } from 'xstate';

type BridgeRevivalEvent =
  | { readonly type: 'TAP_LEFT' }
  | { readonly type: 'AGENT_STARTED' }
  | { readonly type: 'WRITE_ENDED' };

interface BridgeRevivalContext {
  // How long the session waits without a tap before its next check.
  readonly delayMs: number;

  // Whether the tap left again while a write was under way.
  readonly isLostAgain: boolean;
}

const FIRST_DELAY_MS = 30_000;
const MAX_DELAY_MS = 30 * 60_000;

// One session's tap and the check that follows each loss or agent start. The
// revival provides the guards, which read the session, and the write, which
// it performs; each write doubles the wait before the next check.
export const BRIDGE_REVIVAL_MACHINE = setup({
  types: machineTypes<{ context: BridgeRevivalContext; events: BridgeRevivalEvent }>(),
  guards: {
    isLostAgain: (args) => args.context.isLostAgain,
    isGone: () => false,
    hasTap: () => false,
    isAsleep: () => false,
    canWrite: () => false,
  },
  actions: {
    writeBridge: () => {},
  },
  delays: {
    revivalDelay: (args) => args.context.delayMs,
  },
}).createMachine({
  id: 'bridge-revival',
  initial: 'tapped',
  context: { delayMs: FIRST_DELAY_MS, isLostAgain: false },
  states: {
    tapped: {
      on: { TAP_LEFT: 'waiting', AGENT_STARTED: 'waiting' },
    },
    waiting: {
      // a later loss starts the wait again
      on: { TAP_LEFT: { target: 'waiting', reenter: true } },
      after: {
        revivalDelay: [
          { guard: 'hasTap', target: 'tapped' },

          // a sleeping host has no terminal, and its loss stays pending so a
          // wake finds it
          { guard: 'isAsleep', target: 'waiting', reenter: true },
          { guard: 'isGone', target: 'gone' },
          {
            guard: 'canWrite',
            target: 'writing',
            actions: assign({
              delayMs: (args) => Math.min(args.context.delayMs * 2, MAX_DELAY_MS),
              isLostAgain: false,
            }),
          },
          { target: 'tapped' },
        ],
      },
    },
    writing: {
      entry: 'writeBridge',
      on: {
        WRITE_ENDED: [{ guard: 'isLostAgain', target: 'waiting' }, { target: 'tapped' }],

        // a loss during the write starts its wait once the write ends
        TAP_LEFT: { actions: assign({ isLostAgain: true }) },
      },
    },
    gone: {
      type: 'final',
    },
  },
});
