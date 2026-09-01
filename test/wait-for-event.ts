import type { EventMsg } from '../src/protocol/protocol';

/**
 * Polls a growing event list every 20ms until one matches, then returns the
 * first match. Throws, listing the event names seen, when `timeoutMs` passes
 * first.
 */
export async function waitForEvent(
  events: readonly EventMsg[],
  matches: (event: EventMsg) => boolean,
  timeoutMs = 5000,
): Promise<EventMsg> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const found = events.find((event) => matches(event));

    if (found !== undefined) {
      return found;
    }

    await Bun.sleep(20);
  }

  throw new Error(`no matching event; got ${JSON.stringify(events.map((event) => event.ev))}`);
}
