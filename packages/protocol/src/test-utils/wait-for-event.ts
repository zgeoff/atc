import { expect } from 'bun:test';
import { waitFor } from '@zgeoff/testing';

export function waitForEvent<TEvent extends { readonly ev: string }>(
  events: readonly TEvent[],
  shape: Readonly<Record<string, unknown>>,
  options: Parameters<typeof waitFor>[1] = {},
): Promise<TEvent> {
  return waitFor(() => {
    const found = events.find((event) => isMatch(event, shape));

    if (found === undefined) {
      throw new Error(
        `no event matches ${JSON.stringify(shape)}; got ${JSON.stringify(events.map((event) => event.ev))}`,
      );
    }

    return found;
  }, options);
}

// Match on a copy: Bun's matcher overwrites fields of the received object
// with the asymmetric matchers it compares.
function isMatch(event: unknown, shape: Readonly<Record<string, unknown>>): boolean {
  try {
    expect(structuredClone(event)).toMatchObject(shape);

    return true;
  } catch {
    return false;
  }
}
