import type { Clock } from '@zgeoff/std';
import type { Kysely } from 'kysely';
import type { EventSchema } from '../events/event-schema';

export interface MCPAuthSeedDeps {
  readonly db: Kysely<EventSchema>;
  readonly clock: Pick<Clock, 'now'>;
}
