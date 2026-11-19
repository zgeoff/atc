import { AtcError } from '@atcx/contract/light';

// How many events one iterator may hold that its caller has not read.
export const MAX_UNREAD_EVENTS = 10_000;

export interface EventFanOut<T> {
  // An iterator gets the events that arrive after this call.
  readonly subscribe: (signal?: AbortSignal) => AsyncIterable<T>;
  readonly push: (event: T) => void;

  // Ends every iterator, and every iterator that starts later.
  readonly end: () => void;
}

interface Subscriber<T> {
  readonly unread: T[];
  waiter: PromiseWithResolvers<void> | null;
  finished: boolean;
  failure: AtcError | null;
}

export function createEventFanOut<T>(): EventFanOut<T> {
  const subscribers = new Set<Subscriber<T>>();

  let ended = false;

  const finish = (subscriber: Subscriber<T>, failure: AtcError | null) => {
    subscriber.finished = true;
    subscriber.failure = failure;

    subscribers.delete(subscriber);
    subscriber.waiter?.resolve();
  };

  return {
    subscribe: (signal) => {
      const subscriber: Subscriber<T> = {
        unread: [],
        waiter: null,
        finished: ended,
        failure: null,
      };

      if (!ended) {
        subscribers.add(subscriber);
      }

      const onAbort = () => {
        finish(subscriber, null);
      };

      if (signal?.aborted === true) {
        onAbort();
      } else {
        signal?.addEventListener('abort', onAbort, { once: true });
      }

      return {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<T>> => {
            for (;;) {
              const event = subscriber.unread.shift();

              if (event !== undefined) {
                return { done: false, value: event };
              }

              if (subscriber.failure !== null) {
                const failure = subscriber.failure;

                subscriber.failure = null;
                throw failure;
              }

              if (subscriber.finished) {
                signal?.removeEventListener('abort', onAbort);

                return { done: true, value: undefined };
              }

              subscriber.waiter = Promise.withResolvers<void>();

              await subscriber.waiter.promise;

              subscriber.waiter = null;
            }
          },
          return: (): Promise<IteratorResult<T>> => {
            signal?.removeEventListener('abort', onAbort);
            subscriber.unread.length = 0;

            finish(subscriber, null);

            return Promise.resolve({ done: true, value: undefined });
          },
        }),
      };
    },

    push: (event) => {
      for (const subscriber of subscribers) {
        if (subscriber.unread.length >= MAX_UNREAD_EVENTS) {
          subscriber.unread.length = 0;

          finish(
            subscriber,
            new AtcError(
              'events_overflow',
              `an events() iterator fell ${MAX_UNREAD_EVENTS} events behind, so the client ended it`,
            ),
          );
        } else {
          subscriber.unread.push(event);
          subscriber.waiter?.resolve();
        }
      }
    },

    end: () => {
      ended = true;

      for (const subscriber of subscribers) {
        finish(subscriber, null);
      }
    },
  };
}
