import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, sql } from 'kysely';
import type { Expression, ExpressionBuilder, SqlBool, Transaction } from 'kysely';
import type { AdapterEvent } from '../protocol/adapter-event';
import { DaemonError } from '../protocol/daemon-error';
import type { HookEvent } from '../protocol/hook-event';
import type { AgentID } from '../shared/agent-id';
import type { AgentSessionID } from '../shared/agent-session-id';
import { BunSqliteDriver } from '../shared/bun-sqlite-driver';
import type { DaemonID } from '../shared/daemon-id';
import type { MessageID } from '../shared/message-id';
import type { SessionID } from '../shared/session-id';
import { toAgentID } from '../shared/to-agent-id';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toDaemonID } from '../shared/to-daemon-id';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { parseFleetEntry } from './fleet-entry';
import type { FleetEntry, FleetEntryUpdate, LegacyFleetEntry } from './fleet-entry';
import type { EffectTarget, IdempotencyClaim, IdempotencyRecord } from './idempotency-record';
import type { MessageOwner } from './message-owner';
import type { MessageRecord } from './message-record';
import { runMigrations } from './run-migrations';
import type { StateStoreSchema } from './run-migrations';
import type {
  RuntimeAuthBinding,
  RuntimeAuthBindingUpdate,
  RuntimeAuthGrant,
} from './runtime-auth-binding';
import type { TrailEntry } from './trail-entry';
import type {
  MaterializationUpdate,
  SessionWorkspace,
  WorkspaceMaterialization,
} from './workspace-materialization';

// Spelled as the partial index's predicate so SQLite can match them.
const TRAIL_FILTER = sql<boolean>`kind IS NOT NULL AND kind != 'heartbeat'`;

/**
 * Some sessions' slice of the event trail: rows under their atc ids, plus
 * rows under their agent session ids, since rows written before atc session
 * ids stayed stable across restores carry an earlier atc id. A scope of no
 * sessions matches no row.
 */
export interface EventScope {
  readonly atcIDs: readonly SessionID[];
  readonly agentSessionIDs: readonly AgentSessionID[];
}

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

// The target a spawn ran on: its name and the identity the spawned session
// was bound to there.
interface SpawnTarget {
  readonly target: string;
  readonly targetIdentity: string;
}

// A directory a spawn ran in and the target it ran on.
export interface SpawnDir {
  readonly cwd: string;
  readonly grant: SpawnTarget;
}

/**
 * Another message one turn answered, and the atc id it was sent to.
 */
export interface TurnSibling {
  readonly id: MessageID;
  readonly atcID: SessionID;
}

/**
 * One report as the trail holds it. A report recorded before the trail kept
 * whole texts has only its preview, so its text is that preview and
 * `complete` is false.
 */
export interface StoredReport {
  readonly id: number;

  // Epoch ms the report arrived.
  readonly at: number;
  readonly atcID: SessionID;
  readonly agentSessionID: AgentSessionID | null;
  readonly label: string;
  readonly text: string;
  readonly complete: boolean;
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

  // The daemon this store's fleet rows belong to, minted once by the
  // migration that created session ownership.
  readonly daemonID: DaemonID;

  private constructor(sqlite: Database, db: Kysely<StateStoreSchema>, daemonID: DaemonID) {
    this.sqlite = sqlite;
    this.db = db;
    this.daemonID = daemonID;
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

    const daemonIDRow = await db
      .selectFrom('prefs')
      .select('value')
      .where('key', '=', 'daemon_id')
      .executeTakeFirstOrThrow();

    const store = new StateStore(sqlite, db, toDaemonID(daemonIDRow.value));

    if (legacyFleetPath !== undefined) {
      await store.adoptLegacyFleet(legacyFleetPath);
    }

    return store;
  }

  // Only the rows this daemon owns: another daemon's sessions are its own
  // to restore.
  async loadFleet(): Promise<FleetEntry[]> {
    const rows = await this.db
      .selectFrom('fleet')

      // A session's ready workspace comes back with its row.
      .leftJoin('workspace_materialization as workspace', (join) =>
        join
          .onRef('workspace.session_id', '=', 'fleet.session_id')
          .on('workspace.phase', '=', 'ready'),
      )
      .where('fleet.session_id', 'in', (eb) =>
        eb.selectFrom('session_owner').select('session_id').where('daemon_id', '=', this.daemonID),
      )

      // Stored order, which a restore keeps for sessions with no recency.
      .orderBy(sql`fleet.rowid`)
      .select([
        'fleet.session_id',
        'fleet.agent_session_id',
        'fleet.name',
        'fleet.cwd',
        'fleet.pinned',
        'fleet.last_attached',
        'fleet.agent',
        'fleet.exited',
        'fleet.parent_session_id',
        'fleet.prompt',
        'fleet.result',
        'fleet.transcript_path',
        'fleet.model',
        'fleet.effort',
        'fleet.target',
        'fleet.target_identity',
        'workspace.repo_url',
        'workspace.sha',
        'workspace.ref',
        'workspace.materialized_at',
        'workspace.withheld_env',
        'fleet.desired',
        'fleet.host_key',
      ])
      .execute();

    const entries: FleetEntry[] = [];

    for (const row of rows) {
      entries.push({
        sessionID: toSessionID(row.session_id),
        name: row.name,
        cwd: row.cwd,
        ...(row.agent_session_id === null
          ? {}
          : { agentSessionID: toAgentSessionID(row.agent_session_id) }),
        agent: toAgentID(row.agent),
        ...(row.pinned === 0 ? {} : { pinned: true }),
        ...(row.last_attached === null ? {} : { lastAttachedAt: row.last_attached }),
        ...(row.exited === 0 ? {} : { exited: true }),
        ...(row.parent_session_id === null ? {} : { parent: toSessionID(row.parent_session_id) }),
        ...(row.prompt === null ? {} : { prompt: row.prompt }),
        ...(row.result === null ? {} : { result: row.result }),
        ...(row.transcript_path === null ? {} : { transcriptPath: row.transcript_path }),
        ...(row.model === null ? {} : { model: row.model }),
        ...(row.effort === null ? {} : { effort: row.effort }),
        ...(row.target === null ? {} : { target: row.target }),
        ...(row.target_identity === null ? {} : { targetIdentity: row.target_identity }),
        ...buildWorkspaceField(row),
        ...buildWithheldEnvField(row.withheld_env),
        ...(row.desired === 'sleep' || row.desired === 'stop' ? { desired: row.desired } : {}),
        ...(row.host_key === null ? {} : { hostKey: toSessionID(row.host_key) }),
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

  // Rewrites this daemon's rows for the given entries and drops its rows
  // for the removed sessions, plus any row of its own that an entry
  // replaces by holding the same agent session id. Every other row stays as
  // it stands, so a row the daemon never loaded survives a write. A session
  // another daemon owns, or one whose stored ownership epoch has moved past
  // this daemon's, rejects the whole write with stale_epoch.
  async writeFleet(
    entries: readonly FleetEntry[],
    removed: readonly SessionID[] = [],
  ): Promise<void> {
    const kept = buildFleetWithoutReplacedRows(entries);
    const sessionIDs = [...entries.map((entry) => entry.sessionID), ...removed];

    const agentSessionIDs = entries.flatMap((entry) =>
      entry.agentSessionID === undefined ? [] : [entry.agentSessionID],
    );

    await this.db.transaction().execute(async (trx) => {
      await requireCurrentOwnership(
        trx,
        this.daemonID,
        entries.map((entry) => entry.sessionID),
      );

      const replaced =
        agentSessionIDs.length === 0
          ? []
          : await trx
              .selectFrom('fleet')
              .select(['session_id', 'agent_session_id'])
              .where('agent_session_id', 'in', agentSessionIDs)
              .execute();

      const dropped = [...new Set([...sessionIDs, ...replaced.map((row) => row.session_id)])];

      if (dropped.length > 0) {
        await trx
          .deleteFrom('fleet')
          .where('session_id', 'in', dropped)
          .where('session_id', 'in', (eb) =>
            eb
              .selectFrom('session_owner')
              .select('session_id')
              .where('daemon_id', '=', this.daemonID),
          )
          .execute();

        await trx
          .deleteFrom('session_owner')
          .where('daemon_id', '=', this.daemonID)
          .where('session_id', 'in', dropped)
          .execute();
      }

      const updatedAt = Date.now();

      for (const entry of kept) {
        await trx
          .insertInto('fleet')
          .values({
            session_id: entry.sessionID,
            agent_session_id: entry.agentSessionID ?? null,
            name: entry.name,
            cwd: entry.cwd,
            pinned: entry.pinned === true ? 1 : 0,
            last_attached: entry.lastAttachedAt ?? null,
            agent: entry.agent,
            exited: entry.exited === true ? 1 : 0,
            parent_session_id: entry.parent ?? null,
            prompt: entry.prompt ?? null,
            result: entry.result ?? null,
            transcript_path: entry.transcriptPath ?? null,
            model: entry.model ?? null,
            effort: entry.effort ?? null,
            target: entry.target ?? null,
            target_identity: entry.targetIdentity ?? null,
            desired: entry.desired ?? null,
            host_key: entry.hostKey ?? null,
          })
          .execute();

        await trx
          .insertInto('session_owner')
          .values({
            session_id: entry.sessionID,
            daemon_id: this.daemonID,
            owner_epoch: OWNER_EPOCH,
            updated_at: updatedAt,
          })
          .execute();
      }

      // A stored row this write leaves in place follows its replaced parent
      // to the session that replaced it, or to that session's own parent
      // when the replacement is itself a sub-session.
      const survivors = new Map(
        kept.flatMap((entry) =>
          entry.agentSessionID === undefined ? [] : [[entry.agentSessionID, entry] as const],
        ),
      );

      for (const row of replaced) {
        const survivor =
          row.agent_session_id === null
            ? undefined
            : survivors.get(toAgentSessionID(row.agent_session_id));

        if (survivor === undefined || survivor.sessionID === row.session_id) {
          continue;
        }

        await trx
          .updateTable('fleet')
          .set({ parent_session_id: survivor.parent ?? survivor.sessionID })
          .where('parent_session_id', '=', row.session_id)
          .where('session_id', 'in', (eb) =>
            eb
              .selectFrom('session_owner')
              .select('session_id')
              .where('daemon_id', '=', this.daemonID),
          )
          .execute();
      }
    });
  }

  // Rewrites fields on one existing row and leaves every other row as it
  // stands. A session without a row yet is a no-op: the next fleet write
  // inserts it with these fields.
  async updateFleetEntry(sessionID: SessionID, fields: FleetEntryUpdate): Promise<void> {
    const values = {
      ...(fields.result === undefined ? {} : { result: fields.result }),
      ...(fields.transcriptPath === undefined ? {} : { transcript_path: fields.transcriptPath }),
    };

    if (Object.keys(values).length === 0) {
      return;
    }

    await this.db.transaction().execute(async (trx) => {
      await requireCurrentOwnership(trx, this.daemonID, [sessionID]);

      await trx.updateTable('fleet').set(values).where('session_id', '=', sessionID).execute();
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

  // Returns whether the entry was written: a report whose id the trail
  // already holds is left out.
  async recordTrailEntry(entry: TrailEntry): Promise<boolean> {
    const result = await this.db
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
        report_id: entry.kind === 'report' ? (entry.reportID ?? null) : null,
        report_text: entry.kind === 'report' ? entry.text : null,
      })
      .onConflict((oc) => oc.column('report_id').doNothing())
      .executeTakeFirst();

    return result.numInsertedOrUpdatedRows !== 0n;
  }

  async collectEventsAfter(
    afterID: number,
    limit: number,
    scope: EventScope | null = null,
  ): Promise<StoredEvent[]> {
    const rows = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'kind', 'detail', 'message'])
      .where('id', '>', afterID)
      .where(TRAIL_FILTER)
      .where((eb) => buildScopeMatch(eb, scope))
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();

    return buildStoredEvents(rows);
  }

  // A row that is not a report, or that lies outside the scope, misses as a
  // row the trail never held does.
  async findReport(id: number, scope: EventScope | null = null): Promise<StoredReport | null> {
    const row = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'message', 'detail', 'report_text'])
      .where('id', '=', id)
      .where('kind', '=', 'report')
      .where((eb) => buildScopeMatch(eb, scope))
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    return {
      id: row.id,
      at: Date.parse(row.ts),
      atcID: toSessionID(row.atc_id),
      agentSessionID: row.session_id === null ? null : toAgentSessionID(row.session_id),
      label: row.message ?? '',
      text: row.report_text ?? row.detail ?? '',
      complete: row.report_text !== null,
    };
  }

  async collectLatestEvents(
    limit: number,
    scope: EventScope | null = null,
  ): Promise<StoredEvent[]> {
    const rows = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'kind', 'detail', 'message'])
      .where(TRAIL_FILTER)
      .where((eb) => buildScopeMatch(eb, scope))
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();

    return buildStoredEvents(rows).toReversed();
  }

  // Matches the session by either id, since rows written before atc session
  // ids stayed stable across restores carry an earlier atc id.
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

  async recordSpawnDir(cwd: string, grant: SpawnTarget): Promise<void> {
    await this.db
      .insertInto('spawn_history')
      .values({
        cwd,
        target: grant.target,
        target_identity: grant.targetIdentity,
        last_spawn: Date.now(),
      })
      .onConflict((oc) =>
        oc
          .columns(['cwd', 'target', 'target_identity'])
          .doUpdateSet((eb) => ({ last_spawn: eb.ref('excluded.last_spawn') })),
      )
      .execute();
  }

  /**
   * Each directory a spawn ran in, with the target it ran on, most recent
   * first. A directory spawned on several targets has one entry for each.
   */
  async collectSpawnDirs(): Promise<SpawnDir[]> {
    const rows = await this.db
      .selectFrom('spawn_history')
      .select(['cwd', 'target', 'target_identity'])
      .orderBy('last_spawn', 'desc')
      .execute();

    return rows.map((row) => ({
      cwd: row.cwd,
      grant: { target: row.target, targetIdentity: row.target_identity },
    }));
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

  // The other messages of the same session the given message's turn
  // answered, oldest first; none when the message has no turn.
  async collectTurnSiblings(record: MessageRecord): Promise<TurnSibling[]> {
    if (record.turn === undefined) {
      return [];
    }

    const owner: MessageOwner =
      record.agentSessionID === undefined
        ? { atcID: record.atcID }
        : { atcID: record.atcID, agentSessionID: record.agentSessionID };

    const rows = await this.db
      .selectFrom('messages')
      .select(['id', 'atc_id'])
      .where('turn_id', '=', record.turn)
      .where('id', '!=', record.id)
      .where((eb) => buildOwnerFilter(eb, owner))
      .orderBy('sent_at', 'asc')
      .orderBy(sql`rowid`, 'asc')
      .execute();

    return rows.map((row) => ({ id: toMessageID(row.id), atcID: toSessionID(row.atc_id) }));
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

  // Answers every given message the owner holds unanswered in one statement,
  // so a reader sees all of one turn's messages answered or none of them.
  // Returns the messages it answered, oldest first.
  async updateMessagesAnswered(
    ids: readonly MessageID[],
    owner: MessageOwner,
    answer: string,
    at: number,
    turn: string | null = null,
  ): Promise<MessageRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.db
      .updateTable('messages')
      .set({ status: 'answered', answered_at: at, answer, turn_id: turn })
      .where('id', 'in', ids)
      .where('status', 'in', ['accepted', 'delivered'])
      .where((eb) => buildOwnerFilter(eb, owner))
      .returningAll()
      .execute();

    return rows.map((row) => toMessageRecord(row)).toSorted((a, b) => a.sentAt - b.sentAt);
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

  // Records a key in progress unless one is already held under the same
  // principal and operation. Returns null when this call claimed the key,
  // else the record the key already holds.
  async claimIdempotencyKey(claim: IdempotencyClaim): Promise<IdempotencyRecord | null> {
    const inserted = await this.db
      .insertInto('idempotency')
      .values({
        principal: claim.principal,
        operation: claim.operation,
        key: claim.key,
        payload_hash: claim.payloadHash,
        state: 'in_progress',
        effect_ref: claim.effectRef,
        result: null,
        created_at: claim.at,
        updated_at: claim.at,
        effect_target: null,
        effect_target_identity: null,
      })
      .onConflict((oc) => oc.columns(['principal', 'operation', 'key']).doNothing())
      .returning('key')
      .executeTakeFirst();

    if (inserted !== undefined) {
      return null;
    }

    const row = await this.db
      .selectFrom('idempotency')
      .selectAll()
      .where('principal', '=', claim.principal)
      .where('operation', '=', claim.operation)
      .where('key', '=', claim.key)
      .executeTakeFirstOrThrow();

    return toIdempotencyRecord(row);
  }

  // The record a key holds under its principal and operation, or null when
  // the ledger holds none.
  async findIdempotencyKey(
    id: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
  ): Promise<IdempotencyRecord | null> {
    const row = await this.db
      .selectFrom('idempotency')
      .selectAll()
      .where('principal', '=', id.principal)
      .where('operation', '=', id.operation)
      .where('key', '=', id.key)
      .executeTakeFirst();

    return row === undefined ? null : toIdempotencyRecord(row);
  }

  async updateIdempotencyCompleted(
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
    result: string,
    at: number,
    effectTarget: EffectTarget | null = null,
  ): Promise<void> {
    await this.db
      .updateTable('idempotency')
      .set({
        state: 'completed',
        result,
        updated_at: at,
        effect_target: effectTarget?.target ?? null,
        effect_target_identity: effectTarget?.targetIdentity ?? null,
      })
      .where('principal', '=', record.principal)
      .where('operation', '=', record.operation)
      .where('key', '=', record.key)
      .execute();
  }

  // Keeps a claim whose effect may still stand as outcome_unknown, so a
  // retry answers from it and never runs the effect again.
  async updateIdempotencyOutcomeUnknown(
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
    at: number,
  ): Promise<void> {
    await this.db
      .updateTable('idempotency')
      .set({ state: 'outcome_unknown', updated_at: at })
      .where('principal', '=', record.principal)
      .where('operation', '=', record.operation)
      .where('key', '=', record.key)
      .execute();
  }

  // Drops a claim whose effect never started, so a retry runs it fresh.
  async removeIdempotencyKey(
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
  ): Promise<void> {
    await this.db
      .deleteFrom('idempotency')
      .where('principal', '=', record.principal)
      .where('operation', '=', record.operation)
      .where('key', '=', record.key)
      .execute();
  }

  // Runs once as a daemon starts, before it serves a request: every key
  // still in progress belonged to a daemon that stopped mid-effect, so its
  // outcome is unknown. A key whose effect left its row behind completes;
  // one whose effect left no trace stays unknown.
  async reconcileIdempotencyKeys(at: number): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('idempotency')
        .set({ state: 'outcome_unknown', updated_at: at })
        .where('state', '=', 'in_progress')
        .execute();

      // A spawn that completes here records the target its fleet row holds,
      // as a spawn that completes as it runs does.
      await trx
        .updateTable('idempotency')
        .set((eb) => ({
          state: 'completed',
          updated_at: at,
          effect_target: eb
            .selectFrom('fleet')
            .select('fleet.target')
            .whereRef('fleet.session_id', '=', 'idempotency.effect_ref'),
          effect_target_identity: eb
            .selectFrom('fleet')
            .select('fleet.target_identity')
            .whereRef('fleet.session_id', '=', 'idempotency.effect_ref'),
        }))
        .where('state', '=', 'outcome_unknown')
        .where('operation', '=', 'session.spawn')
        .where('effect_ref', 'in', (eb) => eb.selectFrom('fleet').select('session_id'))
        .execute();

      await trx
        .updateTable('idempotency')
        .set({ state: 'completed', updated_at: at })
        .where('state', '=', 'outcome_unknown')
        .where('operation', '=', 'session.message')
        .where('effect_ref', 'in', (eb) => eb.selectFrom('messages').select('id'))
        .execute();
    });
  }

  // Only completed keys expire: a key whose outcome is unknown stays, so a
  // retry of it keeps answering outcome_unknown instead of running anew.
  async removeExpiredIdempotencyKeys(before: number): Promise<void> {
    await this.db
      .deleteFrom('idempotency')
      .where('state', '=', 'completed')
      .where('updated_at', '<', before)
      .execute();
  }

  // Records a materialization as it starts, in the resolving phase.
  async createMaterialization(
    row: Pick<
      WorkspaceMaterialization,
      'sessionID' | 'target' | 'dir' | 'sourceKind' | 'withheldEnv'
    >,
    at: number,
  ): Promise<void> {
    await this.db
      .insertInto('workspace_materialization')
      .values({
        session_id: row.sessionID,
        target: row.target,
        dir: row.dir,
        source_kind: row.sourceKind,
        phase: 'resolving',
        repo_url: null,
        sha: null,
        ref: null,
        error_code: null,
        started_at: at,
        updated_at: at,
        materialized_at: null,
        withheld_env: JSON.stringify(row.withheldEnv),
      })
      .execute();
  }

  async updateMaterialization(
    sessionID: SessionID,
    fields: MaterializationUpdate,
    at: number,
  ): Promise<void> {
    await this.db
      .updateTable('workspace_materialization')
      .set({
        phase: fields.phase,
        ...(fields.repoURL === undefined ? {} : { repo_url: fields.repoURL }),
        ...(fields.sha === undefined ? {} : { sha: fields.sha }),
        ...(fields.ref === undefined ? {} : { ref: fields.ref }),
        ...(fields.errorCode === undefined ? {} : { error_code: fields.errorCode }),
        ...(fields.materializedAt === undefined ? {} : { materialized_at: fields.materializedAt }),
        updated_at: at,
      })
      .where('session_id', '=', sessionID)
      .execute();
  }

  async findMaterialization(sessionID: SessionID): Promise<WorkspaceMaterialization | null> {
    const row = await this.db
      .selectFrom('workspace_materialization')
      .selectAll()
      .where('session_id', '=', sessionID)
      .executeTakeFirst();

    return row === undefined ? null : toWorkspaceMaterialization(row);
  }

  // Runs once as a daemon starts, before it serves a request: a
  // materialization still short of ready or failed belonged to a daemon that
  // stopped partway through it, and its workspace was never verified, so it
  // fails as interrupted.
  async reconcileMaterializations(at: number): Promise<void> {
    await this.db
      .updateTable('workspace_materialization')
      .set({ phase: 'failed', error_code: 'workspace_interrupted', updated_at: at })
      .where('phase', 'not in', ['ready', 'failed'])
      .execute();
  }

  // Records a host's binding as its first attempt starts provisioning it,
  // at the first revision, before the imp exists.
  async createAuthBinding(
    row: Pick<
      RuntimeAuthBinding,
      | 'hostKey'
      | 'target'
      | 'targetIdentity'
      | 'impName'
      | 'bindingHash'
      | 'bindingJSON'
      | 'attemptID'
    >,
    at: number,
  ): Promise<void> {
    await this.db
      .insertInto('runtime_auth_binding')
      .values({
        host_key: row.hostKey,
        target: row.target,
        target_identity: row.targetIdentity,
        imp_name: row.impName,
        imp_id: null,
        revision: 1,
        binding_hash: row.bindingHash,
        binding_json: row.bindingJSON,
        state: 'provisioning',
        attempt_id: row.attemptID,
        imp_created_by_attempt: 0,
        rebind_revision: null,
        rebind_binding_hash: null,
        rebind_binding_json: null,
        rebind_attempt_id: null,
        created_at: at,
        updated_at: at,
        revoked_at: null,
      })
      .execute();
  }

  async updateAuthBinding(
    hostKey: SessionID,
    fields: RuntimeAuthBindingUpdate,
    at: number,
  ): Promise<void> {
    await this.db
      .updateTable('runtime_auth_binding')
      .set({
        ...(fields.state === undefined ? {} : { state: fields.state }),
        ...(fields.impID === undefined ? {} : { imp_id: fields.impID }),
        ...(fields.impCreatedByAttempt === undefined
          ? {}
          : { imp_created_by_attempt: fields.impCreatedByAttempt ? 1 : 0 }),
        ...(fields.revision === undefined ? {} : { revision: fields.revision }),
        ...(fields.bindingHash === undefined ? {} : { binding_hash: fields.bindingHash }),
        ...(fields.bindingJSON === undefined ? {} : { binding_json: fields.bindingJSON }),
        ...(fields.attemptID === undefined ? {} : { attempt_id: fields.attemptID }),
        ...(fields.rebind === undefined
          ? {}
          : {
              rebind_revision: fields.rebind?.revision ?? null,
              rebind_binding_hash: fields.rebind?.bindingHash ?? null,
              rebind_binding_json: fields.rebind?.bindingJSON ?? null,
              rebind_attempt_id: fields.rebind?.attemptID ?? null,
            }),
        ...(fields.revokedAt === undefined ? {} : { revoked_at: fields.revokedAt }),
        updated_at: at,
      })
      .where('host_key', '=', hostKey)
      .execute();
  }

  async findAuthBinding(hostKey: SessionID): Promise<RuntimeAuthBinding | null> {
    const row = await this.db
      .selectFrom('runtime_auth_binding')
      .selectAll()
      .where('host_key', '=', hostKey)
      .executeTakeFirst();

    return row === undefined ? null : toRuntimeAuthBinding(row);
  }

  // Every host's binding, by host key.
  async collectAuthBindings(): Promise<RuntimeAuthBinding[]> {
    const rows = await this.db
      .selectFrom('runtime_auth_binding')
      .selectAll()
      .orderBy('host_key')
      .execute();

    return rows.map((row) => toRuntimeAuthBinding(row));
  }

  // Writes one secret's grant row for a host, or moves the existing one to
  // the given phase, revision and attempt.
  async upsertAuthGrant(grant: Omit<RuntimeAuthGrant, 'updatedAt'>, at: number): Promise<void> {
    await this.db
      .insertInto('runtime_auth_grant')
      .values({
        host_key: grant.hostKey,
        secret: grant.secret,
        revision: grant.revision,
        attempt_id: grant.attemptID,
        preexisting: grant.preexisting ? 1 : 0,
        phase: grant.phase,
        updated_at: at,
      })
      .onConflict((oc) =>
        oc.columns(['host_key', 'secret']).doUpdateSet((eb) => ({
          revision: eb.ref('excluded.revision'),
          attempt_id: eb.ref('excluded.attempt_id'),
          preexisting: eb.ref('excluded.preexisting'),
          phase: eb.ref('excluded.phase'),
          updated_at: eb.ref('excluded.updated_at'),
        })),
      )
      .execute();
  }

  // A host's grant rows, by secret name.
  async collectAuthGrants(hostKey: SessionID): Promise<RuntimeAuthGrant[]> {
    const rows = await this.db
      .selectFrom('runtime_auth_grant')
      .selectAll()
      .where('host_key', '=', hostKey)
      .orderBy('secret')
      .execute();

    return rows.map((row) => ({
      hostKey: toSessionID(row.host_key),
      secret: row.secret,
      revision: row.revision,
      attemptID: row.attempt_id,
      preexisting: row.preexisting === 1,
      phase: row.phase,
      updatedAt: row.updated_at,
    }));
  }

  // Drops a host's binding and every grant row it holds together, once
  // impd confirms the imp and its grants gone.
  async removeAuthBinding(hostKey: SessionID): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('runtime_auth_grant').where('host_key', '=', hostKey).execute();
      await trx.deleteFrom('runtime_auth_binding').where('host_key', '=', hostKey).execute();
    });
  }

  // Runs once as a daemon starts, before it serves a request: a grant still
  // granting belonged to a daemon that stopped before impd answered, so
  // whether impd holds it is uncertain until its grant list is read.
  async reconcileAuthBindings(at: number): Promise<void> {
    await this.db
      .updateTable('runtime_auth_grant')
      .set({ phase: 'uncertain', updated_at: at })
      .where('phase', '=', 'granting')
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

      const legacy: LegacyFleetEntry[] = [];

      for (const entry of parsed) {
        const parsedEntry = parseFleetEntry(entry);

        if (parsedEntry !== undefined) {
          legacy.push(parsedEntry);
        }
      }

      await this.writeFleet(buildFleetFromLegacy(legacy));
    } catch {}
  }
}

// A fleet row's ready workspace as its entry field, or nothing for a row
// that ran without one.
function buildWorkspaceField(
  row: Readonly<{
    repo_url: string | null;
    sha: string | null;
    ref: string | null;
    materialized_at: number | null;
  }>,
): { readonly workspace?: SessionWorkspace } {
  if (row.repo_url === null || row.sha === null || row.materialized_at === null) {
    return {};
  }

  return {
    workspace: {
      repoURL: row.repo_url,
      sha: row.sha,
      ...(row.ref === null ? {} : { ref: row.ref }),
      materializedAt: row.materialized_at,
    },
  };
}

// Two sessions share an agent session id when one resumes the other's agent
// session. The fleet keeps one row per agent session id, the entry written
// last, and relinks the survivors as a one-level hierarchy of rows it holds:
//
// 1. A link to a dropped row follows to the row that replaced it. A row that
//    replaced its own parent follows that parent's link instead, and a link
//    to a row the fleet does not hold makes the row top-level.
// 2. Where the links form a cycle, the row written first in the cycle
//    becomes top-level.
// 3. A row whose parent is itself a sub-session moves up to the top-level
//    row above it.
//
// Every walk takes at most one step per entry, so it ends on any input.
// A ready workspace's withheld variable names as their entry field, or
// nothing for a row that withholds none.
function buildWithheldEnvField(stored: string | null): { readonly withheldEnv?: string[] } {
  const names = parseWithheldEnv(stored);

  return names.length === 0 ? {} : { withheldEnv: names };
}

function parseWithheldEnv(stored: string | null): string[] {
  const parsed: unknown = stored === null ? [] : JSON.parse(stored);

  return Array.isArray(parsed)
    ? parsed.filter((name): name is string => typeof name === 'string')
    : [];
}

function buildFleetWithoutReplacedRows(entries: readonly FleetEntry[]): FleetEntry[] {
  const survivors = new Map<AgentSessionID, SessionID>();

  for (const entry of entries) {
    if (entry.agentSessionID !== undefined) {
      survivors.set(entry.agentSessionID, entry.sessionID);
    }
  }

  const replaced = new Map<SessionID, SessionID>();

  for (const entry of entries) {
    const survivor =
      entry.agentSessionID === undefined ? undefined : survivors.get(entry.agentSessionID);

    if (survivor !== undefined && survivor !== entry.sessionID) {
      replaced.set(entry.sessionID, survivor);
    }
  }

  const kept = entries.filter((entry) => !replaced.has(entry.sessionID));

  const order = new Map(kept.map((entry, index) => [entry.sessionID, index]));
  const links = new Map(entries.map((entry) => [entry.sessionID, entry.parent]));

  const bound = entries.length;

  // The surviving row an entry's parent link resolves to, or undefined when
  // it resolves to no row the fleet keeps.
  const findSurvivingParent = (entry: FleetEntry): SessionID | undefined => {
    let link = entry.parent;

    for (let step = 0; step < bound && link !== undefined; step++) {
      const target = replaced.get(link) ?? link;

      if (target !== entry.sessionID) {
        return order.has(target) ? target : undefined;
      }

      link = links.get(link);
    }

    return undefined;
  };

  const linked = new Map(kept.map((entry) => [entry.sessionID, findSurvivingParent(entry)]));

  // The row written first in the cycle a walk up from this row enters, or
  // undefined when the walk reaches a top-level row.
  const findCycleStart = (sessionID: SessionID): SessionID | undefined => {
    const seen: SessionID[] = [];
    let current: SessionID | undefined = sessionID;

    for (let step = 0; step <= bound && current !== undefined; step++) {
      const at = seen.indexOf(current);

      if (at !== -1) {
        return seen.slice(at).toSorted((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))[0];
      }

      seen.push(current);

      current = linked.get(current);
    }

    return undefined;
  };

  for (const entry of kept) {
    const cycleStart = findCycleStart(entry.sessionID);

    if (cycleStart !== undefined) {
      linked.set(cycleStart, undefined);
    }
  }

  // The top-level row a walk up from this row reaches.
  const findTopLevel = (sessionID: SessionID): SessionID => {
    let current = sessionID;

    for (let step = 0; step < bound; step++) {
      const parent = linked.get(current);

      if (parent === undefined) {
        return current;
      }

      current = parent;
    }

    return current;
  };

  const relinked: FleetEntry[] = [];

  for (const entry of kept) {
    const { parent: _parent, ...rest } = entry;
    const top = findTopLevel(entry.sessionID);
    const row = top === entry.sessionID ? rest : { ...rest, parent: top };

    relinked.push(row);
  }

  return relinked;
}

// The ownership epoch this daemon writes under. Nothing moves a session to
// a later epoch yet, so every row this daemon owns holds this one.
const OWNER_EPOCH = 1;

// Rejects a write that touches a session another daemon owns, or one whose
// stored epoch has moved past this daemon's: the write is stale.
async function requireCurrentOwnership(
  trx: Transaction<StateStoreSchema>, // oxlint-disable-line prefer-readonly-parameter-types -- a kysely transaction bound to a live connection; not meaningfully freezable
  daemonID: DaemonID,
  sessionIDs: readonly SessionID[],
): Promise<void> {
  if (sessionIDs.length === 0) {
    return;
  }

  const stale = await trx
    .selectFrom('session_owner')
    .select(['session_id', 'daemon_id', 'owner_epoch'])
    .where('session_id', 'in', sessionIDs)
    .where((eb) => eb.or([eb('daemon_id', '!=', daemonID), eb('owner_epoch', '!=', OWNER_EPOCH)]))
    .executeTakeFirst();

  if (stale !== undefined) {
    throw new DaemonError(
      'stale_epoch',
      `session '${stale.session_id}' is owned by daemon '${stale.daemon_id}' at epoch ${stale.owner_epoch}; this daemon writes as '${daemonID}' at epoch ${OWNER_EPOCH}`,
    );
  }
}

// Mints each legacy entry an atc session id, then moves each sub-session
// link from the parent's agent session id to the parent's minted id.
function buildFleetFromLegacy(legacy: readonly LegacyFleetEntry[]): FleetEntry[] {
  const minted = new Map(legacy.map((entry) => [entry.agentSessionID, toSessionID(randomUUID())]));

  return legacy.map((entry) => {
    const { parent, ...rest } = entry;
    const parentID = parent === undefined ? undefined : minted.get(parent);

    return {
      ...rest,
      sessionID: minted.get(entry.agentSessionID) ?? toSessionID(randomUUID()),
      ...(parentID === undefined ? {} : { parent: parentID }),
    };
  });
}

function buildScopeMatch(
  eb: ExpressionBuilder<StateStoreSchema, 'events'>, // oxlint-disable-line prefer-readonly-parameter-types -- a kysely expression builder bound to a live query; not meaningfully freezable
  scope: EventScope | null,
): Expression<SqlBool> {
  if (scope === null) {
    return eb.lit(true);
  }

  if (scope.atcIDs.length === 0 && scope.agentSessionIDs.length === 0) {
    return eb.lit(false);
  }

  return eb.or([
    ...(scope.atcIDs.length === 0 ? [] : [eb('atc_id', 'in', scope.atcIDs)]),
    ...(scope.agentSessionIDs.length === 0 ? [] : [eb('session_id', 'in', scope.agentSessionIDs)]),
  ]);
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

function toIdempotencyRecord(row: Readonly<StateStoreSchema['idempotency']>): IdempotencyRecord {
  return {
    principal: row.principal,
    operation: row.operation,
    key: row.key,
    payloadHash: row.payload_hash,
    state: row.state,
    effectRef: row.effect_ref,
    result: row.result,
    effectTarget:
      row.effect_target === null || row.effect_target_identity === null
        ? null
        : { target: row.effect_target, targetIdentity: row.effect_target_identity },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    ...(row.turn_id === null ? {} : { turn: row.turn_id }),
  };
}

function toWorkspaceMaterialization(
  row: Readonly<StateStoreSchema['workspace_materialization']>,
): WorkspaceMaterialization {
  return {
    sessionID: toSessionID(row.session_id),
    target: row.target,
    dir: row.dir,
    sourceKind: row.source_kind,
    phase: row.phase,
    repoURL: row.repo_url,
    sha: row.sha,
    ref: row.ref,
    errorCode: row.error_code,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    materializedAt: row.materialized_at,
    withheldEnv: parseWithheldEnv(row.withheld_env),
  };
}

function toRuntimeAuthBinding(
  row: Readonly<StateStoreSchema['runtime_auth_binding']>,
): RuntimeAuthBinding {
  return {
    hostKey: toSessionID(row.host_key),
    target: row.target,
    targetIdentity: row.target_identity,
    impName: row.imp_name,
    impID: row.imp_id,
    revision: row.revision,
    bindingHash: row.binding_hash,
    bindingJSON: row.binding_json,
    state: row.state,
    attemptID: row.attempt_id,
    impCreatedByAttempt: row.imp_created_by_attempt === 1,
    rebind:
      row.rebind_revision === null ||
      row.rebind_binding_hash === null ||
      row.rebind_binding_json === null ||
      row.rebind_attempt_id === null
        ? null
        : {
            revision: row.rebind_revision,
            bindingHash: row.rebind_binding_hash,
            bindingJSON: row.rebind_binding_json,
            attemptID: row.rebind_attempt_id,
          },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}
