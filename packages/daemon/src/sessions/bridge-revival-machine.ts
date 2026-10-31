import { machineTypes } from '@zgeoff/std';
import { assign, setup } from 'xstate';

type BridgeRevivalEvent =
  | { readonly type: 'TAP_LEFT' }
  | { readonly type: 'AGENT_STARTED' }
  | { readonly type: 'WRITE_ENDED' };

interface BridgeRevivalContext {
  // How long the session waits without a tap before its next check.
  readonly delayMs: number;
}

const FIRST_DELAY_MS = 30_000;
const MAX_DELAY_MS = 30 * 60_000;

// One session's tap and the checks that follow each loss or agent start, until
// a tap attaches. The revival provides the guards, which read the session, and
// the write; each write doubles the wait before the next check.
export const BRIDGE_REVIVAL_MACHINE = setup({
  types: machineTypes<{ context: BridgeRevivalContext; events: BridgeRevivalEvent }>(),
  guards: {
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
  context: { delayMs: FIRST_DELAY_MS },
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
            }),
          },
          { target: 'tapped' },
        ],
      },
    },
    writing: {
      entry: 'writeBridge',

      // Claude Code can turn the mod off again before the reload a write
      // causes starts a tap, and then no tap leaves to start another wait
      on: { WRITE_ENDED: 'waiting' },
    },
    gone: {
      type: 'final',
    },
  },
});
