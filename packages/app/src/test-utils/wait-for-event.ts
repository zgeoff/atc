import { expect } from 'bun:test';
import type { EventMsg } from '../protocol/protocol';
import { waitFor } from './wait-for';

/**
 * Waits until the collected events hold one that matches the shape, as
 * `toMatchObject` matches, and resolves with the first such event. Every
 * event collected so far counts, so a wait finds an event that arrived
 * before it began, and every event stays as it arrived. Throws once the
 * deadline passes, five seconds unless the options set another, listing
 * the shape and the events it saw.
 */
export function waitForEvent(
  events: readonly EventMsg[],
  shape: Readonly<Record<string, unknown>>,
  options: Parameters<typeof waitFor>[1] = {},
): Promise<EventMsg> {
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
function isMatch(event: EventMsg, shape: Readonly<Record<string, unknown>>): boolean {
  try {
    expect(structuredClone(event)).toMatchObject(shape);

    return true;
  } catch {
    return false;
  }
}
