import { expect } from 'bun:test';
import { waitFor } from './wait-for';

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

// The match runs on a copy: Bun's toMatchObject writes each asymmetric
// matcher it compares over the field it matched in the received object.
function isMatch(event: unknown, shape: Readonly<Record<string, unknown>>): boolean {
  try {
    expect(structuredClone(event)).toMatchObject(shape);

    return true;
  } catch {
    return false;
  }
}
