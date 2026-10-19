import { setup } from 'xstate';

type EventFeedEvent =
  | { readonly type: 'OVERFLOW' }
  | { readonly type: 'SUBSCRIBE' }
  | { readonly type: 'UNSUBSCRIBE' };

// A backlog that fills before a subscriber comes is abandoned until one
// does. The machine holds state only; the feed performs every effect and
// reads its state back.
export const EVENT_FEED_MACHINE = setup({
  types: {
    // oxlint-disable-next-line no-unsafe-type-assertion -- xstate's typed-setup contract: this value is never read, it only carries the event union past the type layer
    events: {} as EventFeedEvent,
  },
}).createMachine({
  id: 'event-feed',
  initial: 'collecting',
  states: {
    collecting: {
      on: { OVERFLOW: 'abandoned', SUBSCRIBE: 'subscribed' },
    },
    abandoned: {
      on: { SUBSCRIBE: 'subscribed' },
    },
    subscribed: {
      on: { UNSUBSCRIBE: 'collecting' },
    },
  },
});
