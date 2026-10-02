import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, sql } from 'kysely';
import { toAgentID } from '../agents/agent-adapter';
import type { AdapterEvent, AgentID } from '../agents/agent-adapter';
import type { HookEvent } from '../daemon/hooks';
import type { AgentSessionID } from '../shared/agent-session-id';
import type { SessionID } from '../shared/session-id';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { BunSqliteDriver } from './bun-sqlite-driver';
import { parseFleetEntry } from './fleet-entry';
import type { FleetEntry } from './fleet-entry';
import { runMigrations } from './run-migrations';
import type { StateStoreSchema } from './run-migrations';

export interface StoredEvent {
  readonly id: number;

  // Epoch ms of ts.
  readonly at: number;
  readonly atcID: SessionID;
  readonly agentSessionID: AgentSessionID | null;
  readonly kind: string;

  // The event's detail, else the hook's message.
  readonly detail: string | null;
}

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
      .select([
        'agent_session_id',
        'name',
        'cwd',
        'pinned',
        'last_attached',
        'agent',
        'exited',
        'parent',
        'prompt',
        'result',
        'transcript_path',
      ])
      .execute();

    const entries: FleetEntry[] = [];

    for (const row of rows) {
      entries.push({
        agentSessionID: toAgentSessionID(row.agent_session_id),
        name: row.name,
        cwd: row.cwd,
        agent: toAgentID(row.agent),
        ...(row.pinned === 0 ? {} : { pinned: true }),
        ...(row.last_attached === null ? {} : { lastAttachedAt: row.last_attached }),
        ...(row.exited === 0 ? {} : { exited: true }),
        ...(row.parent === null ? {} : { parent: toAgentSessionID(row.parent) }),
        ...(row.prompt === null ? {} : { prompt: row.prompt }),
        ...(row.result === null ? {} : { result: row.result }),
        ...(row.transcript_path === null ? {} : { transcriptPath: row.transcript_path }),
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

    const recency = new Map<AgentSessionID, string>();

    for (const row of rows) {
      if (row.session_id === null) {
        continue;
      }

      recency.set(toAgentSessionID(row.session_id), row.ts);
    }

    return recency;
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
            parent: entry.parent ?? null,
            prompt: entry.prompt ?? null,
            result: entry.result ?? null,
            transcript_path: entry.transcriptPath ?? null,
          })
          .orReplace()
          .execute();
      }
    });
  }

  async recordEvent(e: HookEvent, ev: Readonly<AdapterEvent> | null = null): Promise<void> {
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
        kind: ev === null ? null : ev.kind,
        detail: ev?.detail ?? null,
      })
      .execute();
  }

  async collectEventsAfter(afterID: number, limit: number): Promise<StoredEvent[]> {
    const rows = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'kind', 'detail', 'message'])
      .where('id', '>', afterID)
      .where('kind', 'is not', null)
      .where('kind', '!=', 'heartbeat')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();

    return buildStoredEvents(rows);
  }

  async collectLatestEvents(limit: number): Promise<StoredEvent[]> {
    const rows = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'kind', 'detail', 'message'])
      .where('kind', 'is not', null)
      .where('kind', '!=', 'heartbeat')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();

    return buildStoredEvents(rows).toReversed();
  }

  // Matches the session by either id, since a restore re-mints the atc id
  // while the agent session id carries on.
  async loadLastActivityAt(
    atcID: SessionID,
    agentSessionID: AgentSessionID | undefined,
  ): Promise<number | null> {
    const row = await this.db
      .selectFrom('events')
      .select(sql<string | null>`MAX(ts)`.as('ts'))
      .where((eb) =>
        eb.or([
          eb('atc_id', '=', atcID),
          ...(agentSessionID === undefined ? [] : [eb('session_id', '=', agentSessionID)]),
        ]),
      )
      .executeTakeFirst();

    return row?.ts === null || row?.ts === undefined ? null : Date.parse(row.ts);
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

interface EventRow {
  readonly id: number;
  readonly ts: string;
  readonly atc_id: string;
  readonly session_id: string | null;
  readonly kind: string | null;
  readonly detail: string | null;
  readonly message: string | null;
}

function buildStoredEvents(rows: readonly EventRow[]): StoredEvent[] {
  const events: StoredEvent[] = [];

  for (const row of rows) {
    if (row.kind === null) {
      continue;
    }

    events.push({
      id: row.id,
      at: Date.parse(row.ts),
      atcID: toSessionID(row.atc_id),
      agentSessionID: row.session_id === null ? null : toAgentSessionID(row.session_id),
      kind: row.kind,
      detail: row.detail ?? row.message,
    });
  }

  return events;
}
