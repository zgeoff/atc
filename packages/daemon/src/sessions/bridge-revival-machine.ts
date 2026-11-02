import { machineTypes } from '@zgeoff/std';
import { assign, setup } from 'xstate';

type BridgeRevivalEvent =
  | { readonly type: 'TAP_LEFT' }
  | { readonly type: 'TAP_ATTACHED' }
  | { readonly type: 'AGENT_STARTED' }
  | { readonly type: 'WRITE_ENDED' };

interface BridgeRevivalContext {
  // How long the session waits without a tap before its next check.
  readonly delayMs: number;
}

// Claude Code drops a mod that does not load within 10 s and runs the SessionStart hooks only
// once the load settles, so a tap missing this long after the start belongs to a dropped mod.
const START_DELAY_MS = 10_000;
const FIRST_DELAY_MS = 30_000;
const MAX_DELAY_MS = 30 * 60_000;

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
    startDelay: START_DELAY_MS,
    revivalDelay: (args) => args.context.delayMs,
  },
}).createMachine({
  id: 'bridge-revival',
  initial: 'tapped',
  context: { delayMs: FIRST_DELAY_MS },
  states: {
    tapped: {
      on: {
        TAP_LEFT: 'waiting',
        AGENT_STARTED: [
          { guard: 'hasTap', target: 'tapped' },
          { guard: 'canWrite', target: 'starting' },
          { target: 'waiting' },
        ],
      },
    },
    starting: {
      on: { TAP_ATTACHED: 'tapped', TAP_LEFT: 'waiting' },
      after: {
        startDelay: [
          { guard: 'hasTap', target: 'tapped' },
          { guard: 'isAsleep', target: 'waiting' },
          { guard: 'isGone', target: 'gone' },
          { guard: 'canWrite', target: 'writing' },
          { target: 'tapped' },
        ],
      },
    },
    waiting: {
      // a later loss starts the wait again
      on: {
        TAP_LEFT: { target: 'waiting', reenter: true },
        TAP_ATTACHED: 'tapped',
        AGENT_STARTED: [
          { guard: 'hasTap', target: 'tapped' },
          { guard: 'canWrite', target: 'starting' },
        ],
      },
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
