import type { Clock } from '@atc/core/system-clock';

/**
 * How a call settled within its time: answered with a value, failed with
 * an error, or still pending when the time ran out.
 */
export type CallOutcome<T> =
  | { readonly kind: 'answered'; readonly value: T }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'timeout' };

/**
 * Waits for a call for at most `timeoutMs` on the clock, and never throws: a failure or
 * a timeout comes back as a value. A call still pending at the timeout
 * keeps running, and whatever it settles to later is dropped.
 */
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
