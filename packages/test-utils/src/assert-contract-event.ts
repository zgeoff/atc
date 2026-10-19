import { DAEMON_EVENT_SCHEMA } from '@atc/protocol';

// An event as a client received it, before its contract parsed it.
interface ReceivedEvent {
  readonly ev: string;
  readonly [field: string]: unknown;
}

export function assertContractEvent(event: ReceivedEvent): void {
  const parsed = DAEMON_EVENT_SCHEMA.safeParse(event);

  if (!parsed.success) {
    throw new Error(`${event.ev} event outside its contract: ${parsed.error.message}`);
  }

  if (!Bun.deepEquals(parsed.data, event)) {
    throw new Error(
      `${event.ev} event has fields its contract drops: ${JSON.stringify(event)} parsed as ${JSON.stringify(parsed.data)}`,
    );
  }
}
