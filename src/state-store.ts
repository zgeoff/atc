import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from 'kysely';
import type { CompiledQuery } from 'kysely';
import { toAgentID } from './agent-adapter';
import type { AgentID } from './agent-adapter';
import type { AgentSessionID } from './agent-session-id';
import { parseFleetEntry } from './fleet-entry';
import type { FleetEntry } from './fleet-entry';
import type { HookEvent } from './hooks';
import { runMigrations } from './run-migrations';
import type { StateStoreSchema } from './run-migrations';
import { toSQLBindings } from './to-sql-bindings';

/**
 * Daemon state in one SQLite store: the restorable fleet, the hook-event
 * debug trail, and the spawn-directory history. The statusline contract
 * file (status.json) stays a plain file because reporters inside wrangled
 * sessions read it without speaking to the daemon. An existing fleet.json
 * seeds the fleet table once, so upgrading never loses a restorable fleet.
 * Every query is built through kysely against the schema the migration
 * ladder maintains and run synchronously against the same bun:sqlite
 * handle, keeping the store's public methods synchronous.
 */
export class StateStore {
  private readonly sqlite: Database;

  private readonly db: Kysely<StateStoreSchema>;

  constructor(dbPath: string, legacyFleetPath?: string) {
    this.sqlite = new Database(dbPath, { create: true });

    this.sqlite.run('PRAGMA journal_mode = WAL;');

    // Kysely builds and compiles here but never runs anything: every query
    // ends in `.compile()` and executes on the bun:sqlite handle above, which
    // is what keeps this store's methods synchronous.
    this.db = new Kysely<StateStoreSchema>({
      dialect: {
        createAdapter: () => new SqliteAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new SqliteIntrospector(db),
        createQueryCompiler: () => new SqliteQueryCompiler(),
      },
    });

    runMigrations(this.sqlite, this.db);

    if (legacyFleetPath !== undefined) {
      this.adoptLegacyFleet(legacyFleetPath);
    }
  }

  loadFleet(): FleetEntry[] {
    const rows = collectRows(
      this.sqlite,
      this.db
        .selectFrom('fleet')
        .select(['agent_session_id', 'name', 'cwd', 'pinned', 'last_attached', 'agent', 'exited'])
        .compile(),
    );

    const entries: FleetEntry[] = [];

    for (const row of rows) {
      entries.push({
        // oxlint-disable-next-line no-unsafe-type-assertion -- the fleet table's primary key is a stored agent session id by schema contract; this is the one point where it is trusted
        agentSessionID: row.agent_session_id as AgentSessionID,
        name: row.name,
        cwd: row.cwd,
        agent: toAgentID(row.agent),
        ...(row.pinned === 0 ? {} : { pinned: true }),
        ...(row.last_attached === null ? {} : { lastAttachedAt: row.last_attached }),
        ...(row.exited === 0 ? {} : { exited: true }),
      });
    }

    return entries;
  }

  // The latest hook-event timestamp per agent session id, from the event
  // trail. Sessions that never reported an event are absent.
  collectFleetRecency(): Map<AgentSessionID, string> {
    const rows = collectRows(
      this.sqlite,
      this.db
        .selectFrom('events')
        .select(['session_id', sql<string>`MAX(ts)`.as('ts')])
        .where('session_id', 'is not', null)
        .groupBy('session_id')
        .compile(),
    );

    return new Map(
      rows.map((row) => [
        // oxlint-disable-next-line no-unsafe-type-assertion -- the events table's session_id column is a recorded agent session id by contract; this is the one point where it is trusted
        row.session_id as AgentSessionID,
        row.ts,
      ]),
    );
  }

  writeFleet(entries: readonly FleetEntry[]): void {
    const replace = this.sqlite.transaction((all: readonly FleetEntry[]) => {
      applyCompiled(this.sqlite, this.db.deleteFrom('fleet').compile());

      for (const entry of all) {
        applyCompiled(
          this.sqlite,
          this.db
            .insertInto('fleet')
            .values({
              agent_session_id: entry.agentSessionID,
              name: entry.name,
              cwd: entry.cwd,
              pinned: entry.pinned === true ? 1 : 0,
              last_attached: entry.lastAttachedAt ?? null,
              agent: entry.agent,
              exited: entry.exited === true ? 1 : 0,
            })
            .orReplace()
            .compile(),
        );
      }
    });

    replace(entries);
  }

  recordEvent(e: HookEvent): void {
    const rawMessage = e.payload['message'];
    const rawSessionID = e.payload['session_id'] ?? e.payload['sessionId'];
    const message = typeof rawMessage === 'string' ? rawMessage : null;
    const sessionID = typeof rawSessionID === 'string' ? rawSessionID : null;
    const atcID: string = e.atcId;

    applyCompiled(
      this.sqlite,
      this.db
        .insertInto('events')
        .values({
          ts: new Date().toISOString(),
          atc_id: atcID,
          event: e.event,
          message,
          session_id: sessionID,
        })
        .compile(),
    );
  }

  recordSpawnDir(cwd: string): void {
    applyCompiled(
      this.sqlite,
      this.db
        .insertInto('spawn_history')
        .values({ cwd, last_spawn: Date.now() })
        .onConflict((oc) =>
          oc.column('cwd').doUpdateSet((eb) => ({ last_spawn: eb.ref('excluded.last_spawn') })),
        )
        .compile(),
    );
  }

  collectSpawnDirs(): string[] {
    const rows = collectRows(
      this.sqlite,
      this.db.selectFrom('spawn_history').select('cwd').orderBy('last_spawn', 'desc').compile(),
    );

    return rows.map((row) => row.cwd);
  }

  loadLastUsedAgent(): AgentID {
    const row = findRow(
      this.sqlite,
      this.db.selectFrom('prefs').select('value').where('key', '=', 'last_used_agent').compile(),
    );

    return toAgentID(row?.value);
  }

  writeLastUsedAgent(agent: AgentID): void {
    applyCompiled(
      this.sqlite,
      this.db
        .insertInto('prefs')
        .values({ key: 'last_used_agent', value: agent })
        .onConflict((oc) =>
          oc.column('key').doUpdateSet((eb) => ({ value: eb.ref('excluded.value') })),
        )
        .compile(),
    );
  }

  stop(): void {
    this.sqlite.close();
  }

  private adoptLegacyFleet(legacyFleetPath: string): void {
    const count = findRow(
      this.sqlite,
      this.db.selectFrom('fleet').select(this.db.fn.countAll<number>().as('n')).compile(),
    );

    if (count === undefined || count.n > 0 || !existsSync(legacyFleetPath)) {
      return;
    }

    try {
      const parsed: unknown = JSON.parse(readFileSync(legacyFleetPath, 'utf8'));

      if (!Array.isArray(parsed)) {
        return;
      }

      const entries: FleetEntry[] = [];

      for (const entry of parsed) {
        const parsedEntry = parseFleetEntry(entry);

        if (parsedEntry !== undefined) {
          entries.push(parsedEntry);
        }
      }

      this.writeFleet(entries);
    } catch {}
  }
}

function collectRows<T>(sqlite: Database, compiled: CompiledQuery<T>): T[] {
  return sqlite
    .query<T, SQLQueryBindings[]>(compiled.sql)
    .all(...toSQLBindings(compiled.parameters));
}

function findRow<T>(sqlite: Database, compiled: CompiledQuery<T>): T | undefined {
  return (
    sqlite.query<T, SQLQueryBindings[]>(compiled.sql).get(...toSQLBindings(compiled.parameters)) ??
    undefined
  );
}

function applyCompiled(sqlite: Database, compiled: CompiledQuery): void {
  sqlite.run(compiled.sql, toSQLBindings(compiled.parameters));
}
