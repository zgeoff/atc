import { DAEMON_EVENT_SCHEMA } from '@atc/protocol/daemon-event';
import type { EventMsg } from '@atc/protocol/protocol';

/**
 * Throws unless a daemon event, apart from its protocol version, parses
 * under the contract's event schema to the same value, so the schema
 * neither refuses the event nor drops a field of it.
 */
export function assertContractEvent(event: EventMsg): void {
  const { v: _v, ...body } = event;
  const parsed = DAEMON_EVENT_SCHEMA.safeParse(body);

  if (!parsed.success) {
    throw new Error(`${event.ev} event outside its contract: ${parsed.error.message}`);
  }

  if (!Bun.deepEquals(parsed.data, body)) {
    throw new Error(
      `${event.ev} event has fields its contract drops: ${JSON.stringify(body)} parsed as ${JSON.stringify(parsed.data)}`,
    );
  }
}
