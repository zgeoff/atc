import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, sql } from 'kysely';
import type { Expression, ExpressionBuilder, SqlBool } from 'kysely';
import { toAgentID } from '../agents/agent-adapter';
import type { AdapterEvent, AgentID } from '../agents/agent-adapter';
import type { HookEvent } from '../daemon/hooks';
import type { AgentSessionID } from '../shared/agent-session-id';
import type { MessageID } from '../shared/message-id';
import type { SessionID } from '../shared/session-id';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { BunSqliteDriver } from './bun-sqlite-driver';
import { parseFleetEntry } from './fleet-entry';
import type { FleetEntry, FleetEntryUpdate } from './fleet-entry';
import type { MessageOwner } from './message-owner';
import type { MessageRecord } from './message-record';
import { runMigrations } from './run-migrations';
import type { StateStoreSchema } from './run-migrations';
import type { TrailEntry } from './trail-entry';

// Spelled as the partial index's predicate so SQLite can match them.
const TRAIL_FILTER = sql<boolean>`kind IS NOT NULL AND kind != 'heartbeat'`;

export interface StoredEvent {
  readonly id: number;

  // Epoch ms of ts.
  readonly at: number;
  readonly atcID: SessionID;
  readonly agentSessionID: AgentSessionID | null;
  readonly kind: string;

  // The event's detail, else the hook's message.
  readonly detail: string | null;

  // The message id on a message status event.
  readonly message?: MessageID;

  // The report label on a report event.
  readonly label?: string;
}

/**
 * Daemon state in one SQLite store: the restorable fleet, the event trail
 * (hook events, message status changes, and reports) that events.read and
 * lastActivityAt read, the spawn-directory
 * history, and the per-session message inbox. The statusline contract
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

  // Rewrites fields on one existing row and leaves every other row as it
  // stands. A session without a row yet is a no-op: the next fleet write
  // inserts it with these fields.
  async updateFleetEntry(agentSessionID: AgentSessionID, fields: FleetEntryUpdate): Promise<void> {
    const values = {
      ...(fields.result === undefined ? {} : { result: fields.result }),
      ...(fields.transcriptPath === undefined ? {} : { transcript_path: fields.transcriptPath }),
    };

    if (Object.keys(values).length === 0) {
      return;
    }

    await this.db
      .updateTable('fleet')
      .set(values)
      .where('agent_session_id', '=', agentSessionID)
      .execute();
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

  async recordTrailEntry(entry: TrailEntry): Promise<void> {
    await this.db
      .insertInto('events')
      .values({
        ts: new Date(entry.at).toISOString(),
        atc_id: entry.atcID,
        event: entry.kind === 'report' ? 'SessionReport' : 'SessionMessage',

        // The message column holds the message id or the report label; the reads hand it back by kind.
        message: entry.kind === 'report' ? entry.label : entry.message,
        session_id: entry.agentSessionID,
        kind: entry.kind,
        detail: entry.detail,
      })
      .execute();
  }

  async collectEventsAfter(afterID: number, limit: number): Promise<StoredEvent[]> {
    const rows = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'kind', 'detail', 'message'])
      .where('id', '>', afterID)
      .where(TRAIL_FILTER)
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();

    return buildStoredEvents(rows);
  }

  async collectLatestEvents(limit: number): Promise<StoredEvent[]> {
    const rows = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'kind', 'detail', 'message'])
      .where(TRAIL_FILTER)
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

  async writeMessage(record: MessageRecord): Promise<void> {
    await this.db
      .insertInto('messages')
      .values({
        id: record.id,
        atc_id: record.atcID,
        agent_session_id: record.agentSessionID ?? null,
        sender: record.from,
        text: record.text,
        status: record.status,
        sent_at: record.sentAt,
        delivered_at: record.deliveredAt ?? null,
        answered_at: record.answeredAt ?? null,
        answer: record.answer ?? null,
      })
      .execute();
  }

  async collectPendingMessages(owner: MessageOwner): Promise<MessageRecord[]> {
    const rows = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('status', '=', 'accepted')
      .where((eb) => buildOwnerFilter(eb, owner))
      .orderBy('sent_at', 'asc')
      .orderBy(sql`rowid`, 'asc')
      .execute();

    return rows.map((row) => toMessageRecord(row));
  }

  async findMessage(id: MessageID, owner: MessageOwner): Promise<MessageRecord | null> {
    const row = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('id', '=', id)
      .where((eb) => buildOwnerFilter(eb, owner))
      .executeTakeFirst();

    return row === undefined ? null : toMessageRecord(row);
  }

  async findMessageByID(id: MessageID): Promise<MessageRecord | null> {
    const row = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? null : toMessageRecord(row);
  }

  async updateMessageDelivered(
    id: MessageID,
    owner: MessageOwner,
    at: number,
  ): Promise<MessageRecord | null> {
    const row = await this.db
      .updateTable('messages')
      .set({ status: 'delivered', delivered_at: at })
      .where('id', '=', id)
      .where('status', '=', 'accepted')
      .where((eb) => buildOwnerFilter(eb, owner))
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? null : toMessageRecord(row);
  }

  async updateMessageAnswered(
    id: MessageID,
    owner: MessageOwner,
    answer: string,
    at: number,
  ): Promise<MessageRecord | null> {
    const row = await this.db
      .updateTable('messages')
      .set({ status: 'answered', answered_at: at, answer })
      .where('id', '=', id)
      .where('status', 'in', ['accepted', 'delivered'])
      .where((eb) => buildOwnerFilter(eb, owner))
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? null : toMessageRecord(row);
  }

  // Messages sent before the agent reported its session id carry no agent
  // session id; this stamps them once it is known, and moves every message
  // from a previous agent session id to a changed one.
  async updateMessageOwner(
    atcID: SessionID,
    previous: AgentSessionID | undefined,
    next: AgentSessionID,
  ): Promise<void> {
    await this.db
      .updateTable('messages')
      .set({ agent_session_id: next })
      .where((eb) => {
        const unstamped = eb.and([eb('atc_id', '=', atcID), eb('agent_session_id', 'is', null)]);

        return previous === undefined
          ? unstamped
          : eb.or([unstamped, eb('agent_session_id', '=', previous)]);
      })
      .execute();
  }

  // Trail entries written before the agent reported its session id carry
  // none; this stamps them once it is known, so they follow the session
  // across a restore.
  async updateTrailOwner(atcID: SessionID, next: AgentSessionID): Promise<void> {
    await this.db
      .updateTable('events')
      .set({ session_id: next })
      .where('atc_id', '=', atcID)
      .where('session_id', 'is', null)
      .where('kind', 'in', ['message-accepted', 'message-delivered', 'message-answered', 'report'])
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
      ...buildTrailFields(row.kind, row.detail, row.message),
    });
  }

  return events;
}

const MESSAGE_TRAIL_KINDS: ReadonlySet<string> = new Set([
  'message-accepted',
  'message-delivered',
  'message-answered',
]);

// Message and report rows keep their message id or label where hook rows keep
// the hook's message, so only hook rows fall back to it for a detail.
function buildTrailFields(
  kind: string,
  detail: string | null,
  message: string | null,
): Pick<StoredEvent, 'detail' | 'message' | 'label'> {
  if (MESSAGE_TRAIL_KINDS.has(kind)) {
    return { detail, ...(message === null ? {} : { message: toMessageID(message) }) };
  }

  if (kind === 'report') {
    return { detail, ...(message === null ? {} : { label: message }) };
  }

  return { detail: detail ?? message };
}

function buildOwnerFilter(
  eb: ExpressionBuilder<StateStoreSchema, 'messages'>, // oxlint-disable-line prefer-readonly-parameter-types -- a kysely expression builder bound to a live query; not meaningfully freezable
  owner: MessageOwner,
): Expression<SqlBool> {
  const byAtcID = eb('atc_id', '=', owner.atcID);

  return owner.agentSessionID === undefined
    ? byAtcID
    : eb.or([byAtcID, eb('agent_session_id', '=', owner.agentSessionID)]);
}

function toMessageRecord(row: Readonly<StateStoreSchema['messages']>): MessageRecord {
  return {
    id: toMessageID(row.id),
    atcID: toSessionID(row.atc_id),
    ...(row.agent_session_id === null
      ? {}
      : { agentSessionID: toAgentSessionID(row.agent_session_id) }),
    from: row.sender,
    text: row.text,
    status: row.status,
    sentAt: row.sent_at,
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    ...(row.answered_at === null ? {} : { answeredAt: row.answered_at }),
    ...(row.answer === null ? {} : { answer: row.answer }),
  };
}
