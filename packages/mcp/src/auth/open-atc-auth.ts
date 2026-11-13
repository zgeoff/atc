import type { Database } from 'bun:sqlite';
import type { Clock } from '@atc/core';
import { GRANT_SCOPES } from '@atcx/contract';
import type { GrantScope } from '@atcx/contract';
import { openMCPAuth } from '@zgeoff/mcp-auth';
import type { GrantID, MCPAuth, SecuritySink, ServiceTokenFile } from '@zgeoff/mcp-auth';
import { ATC_AUTH_PATHS, ATC_AUTH_TABLES, SERVICE_TOKEN_PREFIX } from './constants';
import { runGrantMigration } from './run-grant-migration';

export type ATCAuth = MCPAuth<GrantScope, null>;

interface ATCAuthOptions {
  readonly database: Database;

  // The public origin: the issuer, with `<origin>/mcp` the one resource.
  readonly origin: string;
  readonly clock: Pick<Clock, 'now'>;
  readonly security: SecuritySink;
  readonly serviceTokens: ServiceTokenFile<GrantScope> | null;
  readonly onGrantRevoked: (grantID: GrantID) => void;
}

// The authorization server `atc mcp --http` and the gateway serve, after the
// grant migration.
export function openATCAuth(options: ATCAuthOptions): Promise<ATCAuth> {
  runGrantMigration(options.database, options.clock.now());

  return openMCPAuth<GrantScope>({
    database: options.database,
    origin: options.origin,
    productName: 'atc',
    scopes: GRANT_SCOPES,
    paths: ATC_AUTH_PATHS,
    tables: ATC_AUTH_TABLES,
    clock: { now: () => options.clock.now() },
    security: options.security,
    onGrantRevoked: options.onGrantRevoked,
    ...(options.serviceTokens === null
      ? {}
      : { serviceTokens: { prefix: SERVICE_TOKEN_PREFIX, file: options.serviceTokens } }),
  });
}
