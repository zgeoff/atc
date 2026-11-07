import type { Clock } from '@atc/core';
import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from '../auth/mcp-auth-schema';

// The handles the seeds of the authorization database take.
export interface MCPAuthSeedDeps {
  readonly db: Kysely<MCPAuthSchema>;
  readonly clock: Pick<Clock, 'now'>;
}
