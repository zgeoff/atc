import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, sql } from 'kysely';
import { toAgentID } from '../agents/agent-adapter';
import type { AgentID } from '../agents/agent-adapter';
import type { HookEvent } from '../daemon/hooks';
import type { AgentSessionID } from '../shared/agent-session-id';
import { BunSqliteDriver } from './bun-sqlite-driver';
import { parseFleetEntry } from './fleet-entry';
import type { FleetEntry } from './fleet-entry';
import { runMigrations } from './run-migrations';
import type { StateStoreSchema } from './run-migrations';

/**
 * Daemon state in one SQLite store: the restorable fleet, the hook-event
 * debug trail, and the spawn-directory history. The statusline contract
 * file (status.json) stays a plain file because reporters inside wrangled
 * sessions read it without speaking to the daemon. An existing fleet.json
 * seeds the fleet table once, so upgrading never loses a restorable fleet.
 * Every query runs through kysely against the schema the migration ladder
 * maintains, executed by a driver over the one bun:sqlite connection this
 * store owns. That makes every method here asynchronous; the driver's
 * connection mutex is what keeps every write ordered regardless.
 */
export class StateStore {
  private readonly sqlite: Database;

  private readonly db: Kysely<StateStoreSchema>;

  private constructor(sqlite: Database, db: Kysely<StateStoreSchema>) {
    this.sqlite = sqlite;
    this.db = db;
  }

  // Migrations run statements that cannot happen inside a constructor, so
  // opening a store is this factory instead of `new`.
  static async open(dbPath: string, legacyFleetPath?: string): Promise<StateStore> {
    const sqlite = new Database(dbPath, { create: true });

    sqlite.run('PRAGMA journal_mode = WAL;');

    const db = new Kysely<StateStoreSchema>({
      dialect: {
        createAdapter: () => new SqliteAdapter(),
        createDriver: () => new BunSqliteDriver(sqlite),
        createIntrospector: (kysely) => new SqliteIntrospector(kysely),
        createQueryCompiler: () => new SqliteQueryCompiler(),
      },
    });

    await runMigrations(db);

    const store = new StateStore(sqlite, db);

    if (legacyFleetPath !== undefined) {
      await store.adoptLegacyFleet(legacyFleetPath);
    }

    return store;
  }

  async loadFleet(): Promise<FleetEntry[]> {
    const rows = await this.db
      .selectFrom('fleet')
      .select(['agent_session_id', 'name', 'cwd', 'pinned', 'last_attached', 'agent', 'exited'])
      .execute();

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
  async collectFleetRecency(): Promise<Map<AgentSessionID, string>> {
    const rows = await this.db
      .selectFrom('events')
      .select(['session_id', sql<string>`MAX(ts)`.as('ts')])
      .where('session_id', 'is not', null)
      .groupBy('session_id')
      .execute();

    return new Map(
      rows.map((row) => [
        // oxlint-disable-next-line no-unsafe-type-assertion -- the events table's session_id column is a recorded agent session id by contract; this is the one point where it is trusted
        row.session_id as AgentSessionID,
        row.ts,
      ]),
    );
  }

  async writeFleet(entries: readonly FleetEntry[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('fleet').execute();

      for (const entry of entries) {
        await trx
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
          .execute();
      }
    });
  }

  async recordEvent(e: HookEvent): Promise<void> {
    const rawMessage = e.payload['message'];
    const rawSessionID = e.payload['session_id'] ?? e.payload['sessionId'];
    const message = typeof rawMessage === 'string' ? rawMessage : null;
    const sessionID = typeof rawSessionID === 'string' ? rawSessionID : null;
    const atcID: string = e.atcId;

    await this.db
      .insertInto('events')
      .values({
        ts: new Date().toISOString(),
        atc_id: atcID,
        event: e.event,
        message,
        session_id: sessionID,
      })
      .execute();
  }

  async recordSpawnDir(cwd: string): Promise<void> {
    await this.db
      .insertInto('spawn_history')
      .values({ cwd, last_spawn: Date.now() })
      .onConflict((oc) =>
        oc.column('cwd').doUpdateSet((eb) => ({ last_spawn: eb.ref('excluded.last_spawn') })),
      )
      .execute();
  }

  async collectSpawnDirs(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('spawn_history')
      .select('cwd')
      .orderBy('last_spawn', 'desc')
      .execute();

    return rows.map((row) => row.cwd);
  }

  async loadLastUsedAgent(): Promise<AgentID> {
    const row = await this.db
      .selectFrom('prefs')
      .select('value')
      .where('key', '=', 'last_used_agent')
      .executeTakeFirst();

    return toAgentID(row?.value);
  }

  async writeLastUsedAgent(agent: AgentID): Promise<void> {
    await this.db
      .insertInto('prefs')
      .values({ key: 'last_used_agent', value: agent })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet((eb) => ({ value: eb.ref('excluded.value') })),
      )
      .execute();
  }

  async stop(): Promise<void> {
    await this.db.destroy();

    this.sqlite.close();
  }

  private async adoptLegacyFleet(legacyFleetPath: string): Promise<void> {
    const count = await this.db
      .selectFrom('fleet')
      .select(this.db.fn.countAll<number>().as('n'))
      .executeTakeFirst();

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

      await this.writeFleet(entries);
    } catch {}
  }
}
