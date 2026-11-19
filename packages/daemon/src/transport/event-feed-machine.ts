import { machineTypes } from '@zgeoff/std';
import { setup } from 'xstate';

type EventFeedEvent =
  | { readonly type: 'OVERFLOW' }
  | { readonly type: 'SUBSCRIBE' }
  | { readonly type: 'UNSUBSCRIBE' };

export const EVENT_FEED_MACHINE = setup({
  types: machineTypes<{ events: EventFeedEvent }>(),
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
