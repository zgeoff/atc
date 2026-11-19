import type { Clock } from '@atc/core';

export type CallOutcome<T> =
  | { readonly kind: 'answered'; readonly value: T }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'timeout' };

export async function waitForOutcome<T>(
  call: Readonly<Promise<T>>,
  timeoutMs: number,
  clock: Clock,
): Promise<CallOutcome<T>> {
  const timeout = Promise.withResolvers<CallOutcome<T>>();

  const cancel = clock.schedule(() => {
    timeout.resolve({ kind: 'timeout' });
  }, timeoutMs);

  const settled = (async (): Promise<CallOutcome<T>> => {
    try {
      return { kind: 'answered', value: await call };
    } catch (error) {
      return { kind: 'failed', error };
    }
  })();

  const outcome = await Promise.race([settled, timeout.promise]);

  cancel();

  return outcome;
}
