import { assign, setup } from 'xstate';

type BridgeRevivalEvent = { readonly type: 'TAP_LEFT' } | { readonly type: 'WRITE_ENDED' };

interface BridgeRevivalContext {
  // How long the session waits without a tap before its next check.
  readonly delayMs: number;
}

const FIRST_DELAY_MS = 30_000;
const MAX_DELAY_MS = 30 * 60_000;

// One session's tap and the check that follows each loss. The revival
// provides the guards, which read the session, and the write, which it
// performs; each write doubles the wait before the next check.
export const BRIDGE_REVIVAL_MACHINE = setup({
  types: {
    // oxlint-disable-next-line no-unsafe-type-assertion -- xstate's typed-setup contract: this value is never read, it only carries the context type past the type layer
    context: {} as BridgeRevivalContext,

    // oxlint-disable-next-line no-unsafe-type-assertion -- xstate's typed-setup contract: this value is never read, it only carries the event union past the type layer
    events: {} as BridgeRevivalEvent,
  },
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
      on: { TAP_LEFT: 'waiting' },
    },
    waiting: {
      // a later loss starts the wait again
      on: { TAP_LEFT: { target: 'waiting', reenter: true } },
      after: {
        revivalDelay: [
          { guard: 'isGone', target: 'gone' },
          { guard: 'hasTap', target: 'tapped' },

          // the loss stays pending while the host sleeps, so a wake finds it
          { guard: 'isAsleep', target: 'waiting', reenter: true },
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
      on: { WRITE_ENDED: 'tapped', TAP_LEFT: 'waiting' },
    },
    gone: {
      type: 'final',
    },
  },
});
