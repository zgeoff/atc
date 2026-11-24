import { buildMockFleetEvent } from './build-mock-fleet-event';

// A page of the gateway's merged trail that holds one event for each cursor named, and no daemon
// state unless the test overrides it.
export function buildMockEventsPage(
  cursor: string,
  eventCursors: readonly string[],
  override: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    events: eventCursors.map((eventCursor) => buildMockFleetEvent(eventCursor)),
    cursor,
    more: false,
    unavailable: [],
    started: [],
    truncated: [],
    ...override,
  };
}
