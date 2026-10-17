import { DAEMON_EVENT_SCHEMA } from '@atc/protocol';
import type { EventMsg } from '@atc/protocol/wire';

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
