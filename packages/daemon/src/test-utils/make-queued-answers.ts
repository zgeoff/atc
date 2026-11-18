import type { Clock } from '@atc/core';
import { match } from 'ts-pattern';

export type QueuedAnswer =
  | { readonly kind: 'refuse'; readonly error: Error }
  | { readonly kind: 'succeed' }
  | { readonly kind: 'succeed-after'; readonly clock: Clock; readonly delayMs: number };

export function makeQueuedAnswers(answers: readonly QueuedAnswer[]): () => Promise<void> {
  const queue = [...answers];

  return () => {
    const answer = queue.shift();

    if (answer === undefined) {
      return Promise.reject(new Error('the stand-in got a call after its answers ran out'));
    }

    return match(answer)
      .with({ kind: 'refuse' }, (refusal) => Promise.reject(refusal.error))
      .with({ kind: 'succeed' }, () => Promise.resolve())
      .with({ kind: 'succeed-after' }, (delayed) => {
        const settled = Promise.withResolvers<void>();

        delayed.clock.schedule(settled.resolve, delayed.delayMs);

        return settled.promise;
      })
      .exhaustive();
  };
}
