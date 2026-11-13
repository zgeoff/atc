import type { Database } from 'bun:sqlite';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import type { EventSchema } from './event-schema';

// atc keeps its MCP Events tables in the authorization database, on a
// connection of their own, so a transaction of atc's never takes in a write
// that @zgeoff/mcp-auth makes on its connection.
export function openEventDatabase(sqlite: Database): Kysely<EventSchema> {
  sqlite.run(
    'create table if not exists atc_event_subscription (id text primary key not null, client_id text not null, url text not null, name text not null, arguments text not null, secret text not null, position text not null, refresh_before text not null, created_at text not null)',
  );

  sqlite.run(
    'create table if not exists atc_event_callback (client_id text not null, url text not null, verified_at text not null, primary key (client_id, url))',
  );

  return new Kysely<EventSchema>({ dialect: buildSQLiteDialect(sqlite) });
}
