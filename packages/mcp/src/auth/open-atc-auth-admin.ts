import type { Database } from 'bun:sqlite';
import { GRANT_SCOPES } from '@atcx/contract';
import { openMCPAuthAdmin } from '@zgeoff/mcp-auth';
import type { MCPAuthAdmin } from '@zgeoff/mcp-auth';
import type { Clock } from '@zgeoff/std';
import { ATC_AUTH_TABLES } from './constants';
import { runGrantMigration } from './run-grant-migration';

export function openATCAuthAdmin(
  database: Database,
  clock: Pick<Clock, 'now'>,
): Promise<MCPAuthAdmin> {
  runGrantMigration(database, clock.now());

  return openMCPAuthAdmin({
    database,
    scopes: GRANT_SCOPES,
    tables: ATC_AUTH_TABLES,
    clock: { now: () => clock.now() },
    onGrantRevoked: () => {},
  });
}
