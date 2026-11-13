import type { Clock } from '@atc/core';
import type { Kysely } from 'kysely';
import type { EventSchema } from '../events/event-schema';

// The handles the seeds of atc's own tables in the authorization database take.
export interface MCPAuthSeedDeps {
  readonly db: Kysely<EventSchema>;
  readonly clock: Pick<Clock, 'now'>;
}
