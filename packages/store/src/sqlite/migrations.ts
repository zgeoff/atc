import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { createSessionOwners } from './create-session-owners';
import { readTableColumns } from './read-table-columns';
import type { StateStoreSchema } from './state-store-schema';
import { updateFleetAgentSessionIDToShared } from './update-fleet-agent-session-id-to-shared';
import { updateFleetKeyToSessionID } from './update-fleet-key-to-session-id';
import { updateSpawnHistoryKeyToTarget } from './update-spawn-history-key-to-target';
import { withImmediateTransaction } from './with-immediate-transaction';

// Every shape the tables have shipped with, oldest first. A step that rebuilds
// a table carries every row across; no step drops a row.
export const MIGRATIONS: Record<string, Migration> = {
  '001_create_initial_schema': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createTable('fleet')
        .ifNotExists()
        .addColumn('claude_id', 'text', (column) => column.primaryKey())
        .addColumn('name', 'text', (column) => column.notNull())
        .addColumn('cwd', 'text', (column) => column.notNull())
        .execute();

      await db.schema
        .createTable('events')
        .ifNotExists()
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('ts', 'text', (column) => column.notNull())
        .addColumn('atc_id', 'text', (column) => column.notNull())
        .addColumn('event', 'text', (column) => column.notNull())
        .addColumn('message', 'text')
        .addColumn('session_id', 'text')
        .execute();

      await db.schema
        .createTable('spawn_history')
        .ifNotExists()
        .addColumn('cwd', 'text', (column) => column.primaryKey())
        .addColumn('last_spawn', 'integer', (column) => column.notNull())
        .execute();

      await db.schema
        .createTable('prefs')
        .ifNotExists()
        .addColumn('key', 'text', (column) => column.primaryKey())
        .addColumn('value', 'text', (column) => column.notNull())
        .execute();
    },
  },
  '002_rename_fleet_claude_id_to_agent_session_id': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').renameColumn('claude_id', 'agent_session_id').execute();
    },
  },
  '003_add_fleet_pinned': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .alterTable('fleet')
        .addColumn('pinned', 'integer', (column) => column.notNull().defaultTo(0))
        .execute();
    },
  },
  '004_add_fleet_last_attached': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('last_attached', 'integer').execute();
    },
  },
  '005_add_fleet_agent': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .alterTable('fleet')
        .addColumn('agent', 'text', (column) => column.notNull().defaultTo('claude'))
        .execute();
    },
  },
  '006_add_fleet_exited': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .alterTable('fleet')
        .addColumn('exited', 'integer', (column) => column.notNull().defaultTo(0))
        .execute();
    },
  },
  '007_add_fleet_parent': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('parent', 'text').execute();
    },
  },
  '008_add_fleet_prompt_result_transcript': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('prompt', 'text').execute();
      await db.schema.alterTable('fleet').addColumn('result', 'text').execute();
      await db.schema.alterTable('fleet').addColumn('transcript_path', 'text').execute();
    },
  },
  '009_add_events_kind_detail': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('events').addColumn('kind', 'text').execute();
      await db.schema.alterTable('events').addColumn('detail', 'text').execute();
    },
  },
  '010_add_events_trail_indexes': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createIndex('events_atc_id_ts')
        .ifNotExists()
        .on('events')
        .columns(['atc_id', 'ts'])
        .execute();

      await db.schema
        .createIndex('events_session_id_ts')
        .ifNotExists()
        .on('events')
        .columns(['session_id', 'ts'])
        .execute();

      // Partial, so the trail reads walk only the rows they return. The
      // predicate text must match the reads' filter for SQLite to pick it.
      await sql`CREATE INDEX IF NOT EXISTS events_trail ON events (id) WHERE kind IS NOT NULL AND kind != 'heartbeat'`.execute(
        db,
      );
    },
  },
  '011_create_messages': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createTable('messages')
        .ifNotExists()
        .addColumn('id', 'text', (column) => column.primaryKey())
        .addColumn('atc_id', 'text', (column) => column.notNull())
        .addColumn('agent_session_id', 'text')
        .addColumn('sender', 'text', (column) => column.notNull())
        .addColumn('text', 'text', (column) => column.notNull())
        .addColumn('status', 'text', (column) => column.notNull())
        .addColumn('sent_at', 'integer', (column) => column.notNull())
        .addColumn('delivered_at', 'integer')
        .addColumn('answered_at', 'integer')
        .addColumn('answer', 'text')
        .execute();
    },
  },
  '012_index_messages_by_owner': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createIndex('messages_atc_id_status_sent_at')
        .ifNotExists()
        .on('messages')
        .columns(['atc_id', 'status', 'sent_at'])
        .execute();

      await db.schema
        .createIndex('messages_agent_session_id_status_sent_at')
        .ifNotExists()
        .on('messages')
        .columns(['agent_session_id', 'status', 'sent_at'])
        .execute();
    },
  },
  '013_add_messages_turn_id': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('messages').addColumn('turn_id', 'text').execute();

      await db.schema
        .createIndex('messages_turn_id')
        .ifNotExists()
        .on('messages')
        .column('turn_id')
        .execute();
    },
  },
  '014_add_fleet_model_effort': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('model', 'text').execute();
      await db.schema.alterTable('fleet').addColumn('effort', 'text').execute();
    },
  },
  '015_rebuild_fleet_keyed_by_session_id': {
    async up(db: Kysely<StateStoreSchema>) {
      // The ledger records this step only after it returns, so a crash in
      // between leaves a rebuilt table behind a ledger that still lacks it.
      const columns = await readTableColumns(db, 'fleet');

      if (columns.has('session_id')) {
        return;
      }

      await withImmediateTransaction(db, () => updateFleetKeyToSessionID(db));
    },
  },
  '016_create_session_owner': {
    async up(db: Kysely<StateStoreSchema>) {
      await withImmediateTransaction(db, () => createSessionOwners(db));
    },
  },
  '017_create_idempotency': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createTable('idempotency')
        .ifNotExists()
        .addColumn('principal', 'text', (column) => column.notNull())
        .addColumn('operation', 'text', (column) => column.notNull())
        .addColumn('key', 'text', (column) => column.notNull())
        .addColumn('payload_hash', 'text', (column) => column.notNull())
        .addColumn('state', 'text', (column) => column.notNull())
        .addColumn('effect_ref', 'text', (column) => column.notNull())
        .addColumn('result', 'text')
        .addColumn('created_at', 'integer', (column) => column.notNull())
        .addColumn('updated_at', 'integer', (column) => column.notNull())
        .addPrimaryKeyConstraint('idempotency_pk', ['principal', 'operation', 'key'])
        .execute();

      await db.schema
        .createIndex('idempotency_state_updated_at')
        .ifNotExists()
        .on('idempotency')
        .columns(['state', 'updated_at'])
        .execute();
    },
  },
  '018_add_fleet_target': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('target', 'text').execute();
      await db.schema.alterTable('fleet').addColumn('target_identity', 'text').execute();
    },
  },
  '019_add_idempotency_effect_target': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('idempotency').addColumn('effect_target', 'text').execute();

      await db.schema
        .alterTable('idempotency')
        .addColumn('effect_target_identity', 'text')
        .execute();
    },
  },
  '020_create_workspace_materialization': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createTable('workspace_materialization')
        .ifNotExists()
        .addColumn('session_id', 'text', (column) => column.primaryKey())
        .addColumn('target', 'text', (column) => column.notNull())
        .addColumn('dir', 'text', (column) => column.notNull())
        .addColumn('source_kind', 'text', (column) => column.notNull())
        .addColumn('phase', 'text', (column) => column.notNull())
        .addColumn('repo_url', 'text')
        .addColumn('sha', 'text')
        .addColumn('ref', 'text')
        .addColumn('error_code', 'text')
        .addColumn('started_at', 'integer', (column) => column.notNull())
        .addColumn('updated_at', 'integer', (column) => column.notNull())
        .addColumn('materialized_at', 'integer')
        .addColumn('withheld_env', 'text')
        .execute();
    },
  },
  '021_add_fleet_lifecycle': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('desired', 'text').execute();
      await db.schema.alterTable('fleet').addColumn('host_key', 'text').execute();
    },
  },
  '022_add_events_report_id': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('events').addColumn('report_id', 'text').execute();

      await db.schema
        .createIndex('events_report_id')
        .ifNotExists()
        .unique()
        .on('events')
        .column('report_id')
        .execute();
    },
  },
  '023_add_events_report_text': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('events').addColumn('report_text', 'text').execute();
    },
  },
  '024_rebuild_spawn_history_keyed_by_target': {
    async up(db: Kysely<StateStoreSchema>) {
      // The ledger records this step only after it returns, so a crash in
      // between leaves a rebuilt table behind a ledger that still lacks it.
      const columns = await readTableColumns(db, 'spawn_history');

      if (columns.has('target')) {
        return;
      }

      await withImmediateTransaction(db, () => updateSpawnHistoryKeyToTarget(db));
    },
  },
  '025_create_runtime_auth': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createTable('runtime_auth_binding')
        .ifNotExists()
        .addColumn('host_key', 'text', (column) => column.primaryKey())
        .addColumn('target', 'text', (column) => column.notNull())
        .addColumn('target_identity', 'text', (column) => column.notNull())
        .addColumn('imp_name', 'text', (column) => column.notNull())
        .addColumn('imp_id', 'text')
        .addColumn('revision', 'integer', (column) => column.notNull())
        .addColumn('binding_hash', 'text', (column) => column.notNull())
        .addColumn('binding_json', 'text', (column) => column.notNull())
        .addColumn('state', 'text', (column) => column.notNull())
        .addColumn('attempt_id', 'text', (column) => column.notNull())
        .addColumn('imp_created_by_attempt', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('rebind_revision', 'integer')
        .addColumn('rebind_binding_hash', 'text')
        .addColumn('rebind_binding_json', 'text')
        .addColumn('rebind_attempt_id', 'text')
        .addColumn('created_at', 'integer', (column) => column.notNull())
        .addColumn('updated_at', 'integer', (column) => column.notNull())
        .addColumn('revoked_at', 'integer')
        .execute();

      await db.schema
        .createTable('runtime_auth_grant')
        .ifNotExists()
        .addColumn('host_key', 'text', (column) => column.notNull())
        .addColumn('secret', 'text', (column) => column.notNull())
        .addColumn('revision', 'integer', (column) => column.notNull())
        .addColumn('attempt_id', 'text', (column) => column.notNull())
        .addColumn('preexisting', 'integer', (column) => column.notNull())
        .addColumn('phase', 'text', (column) => column.notNull())
        .addColumn('updated_at', 'integer', (column) => column.notNull())
        .addPrimaryKeyConstraint('runtime_auth_grant_pk', ['host_key', 'secret'])
        .execute();
    },
  },
  '026_add_fleet_resume_interrupted_turns': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .alterTable('fleet')
        .addColumn('resume_interrupted_turns', 'integer')
        .execute();
    },
  },
  '027_create_published_record': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createTable('published_record')
        .ifNotExists()
        .addColumn('session_id', 'text', (column) => column.primaryKey())
        .addColumn('record', 'text', (column) => column.notNull())
        .addColumn('revision', 'integer', (column) => column.notNull())
        .addColumn('updated_at', 'integer', (column) => column.notNull())
        .execute();
    },
  },
  '028_rename_reports_to_notes_and_accepted_to_queued': {
    async up(db: Kysely<StateStoreSchema>) {
      // Each step can run again after a crash: a column renames only while
      // it still carries the old name, and every value update matches the
      // old value alone.
      const names = await readTableColumns(db, 'events');

      if (names.has('report_id')) {
        await sql`ALTER TABLE events RENAME COLUMN report_id TO note_id`.execute(db);
      }

      if (names.has('report_text')) {
        await sql`ALTER TABLE events RENAME COLUMN report_text TO note_text`.execute(db);
      }

      await sql`DROP INDEX IF EXISTS events_report_id`.execute(db);
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS events_note_id ON events (note_id)`.execute(db);
      await sql`UPDATE events SET kind = 'note' WHERE kind = 'report'`.execute(db);
      await sql`UPDATE events SET event = 'SessionNote' WHERE event = 'SessionReport'`.execute(db);

      await sql`UPDATE events SET kind = 'message-queued' WHERE kind = 'message-accepted'`.execute(
        db,
      );

      await sql`UPDATE messages SET status = 'queued' WHERE status = 'accepted'`.execute(db);

      // A replayed message send answers with the result its first run
      // cached, which holds the status the message was written with.
      await sql`
        UPDATE idempotency
        SET result = json_set(result, '$.status', 'queued')
        WHERE operation = 'session.message'
          AND result IS NOT NULL
          AND json_valid(result)
          AND json_extract(result, '$.status') = 'accepted'
      `.execute(db);
    },
  },
  '029_add_fleet_auth_revision': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('auth_revision', 'integer').execute();
    },
  },
  '030_add_messages_unanswered': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('messages').addColumn('unanswered_at', 'integer').execute();
      await db.schema.alterTable('messages').addColumn('unanswered_reason', 'text').execute();
    },
  },
  '031_rebuild_fleet_without_unique_agent_session_id': {
    async up(db: Kysely<StateStoreSchema>) {
      await withImmediateTransaction(db, async () => {
        await updateFleetAgentSessionIDToShared(db);

        await db.schema
          .createIndex('fleet_agent_session_id')
          .ifNotExists()
          .on('fleet')
          .column('agent_session_id')
          .execute();
      });
    },
  },
  '032_add_messages_answer_notice': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('messages').addColumn('sender_session', 'text').execute();
      await db.schema.alterTable('messages').addColumn('notice_queued_at', 'integer').execute();
      await db.schema.alterTable('messages').addColumn('notice_delivered_at', 'integer').execute();

      await db.schema
        .createIndex('messages_sender_session_notice')
        .ifNotExists()
        .on('messages')
        .columns(['sender_session', 'notice_delivered_at'])
        .execute();
    },
  },
  '033_add_messages_sender_kind': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('messages').addColumn('sender_kind', 'text').execute();
      await db.schema.alterTable('messages').addColumn('sender_id', 'text').execute();
    },
  },
  '034_add_events_answer_text': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('events').addColumn('answer_text', 'text').execute();
    },
  },
  '035_add_fleet_suspended': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('suspended', 'integer').execute();
    },
  },
  '036_add_fleet_plugin_dirs': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('plugin_dirs', 'text').execute();
    },
  },
  '037_drop_fleet_resume_interrupted_turns': {
    async up(db: Kysely<StateStoreSchema>) {
      // Nothing reads the column. The drop runs only while it is there, so
      // the step can run again after a crash.
      const columns = await readTableColumns(db, 'fleet');

      if (columns.has('resume_interrupted_turns')) {
        await db.schema.alterTable('fleet').dropColumn('resume_interrupted_turns').execute();
      }
    },
  },
  '038_rename_runtime_auth_binding_host_columns': {
    async up(db: Kysely<StateStoreSchema>) {
      // A column renames only while it still carries the old name, so the
      // step can run again after a crash.
      const names = await readTableColumns(db, 'runtime_auth_binding');

      if (names.has('imp_name')) {
        await sql`ALTER TABLE runtime_auth_binding RENAME COLUMN imp_name TO host_name`.execute(db);
      }

      if (names.has('imp_id')) {
        await sql`ALTER TABLE runtime_auth_binding RENAME COLUMN imp_id TO host_id`.execute(db);
      }

      if (names.has('imp_created_by_attempt')) {
        await sql`ALTER TABLE runtime_auth_binding RENAME COLUMN imp_created_by_attempt TO host_created_by_attempt`.execute(
          db,
        );
      }
    },
  },
  '039_rename_workspace_materialization_dir_to_directory': {
    async up(db: Kysely<StateStoreSchema>) {
      // The column renames only while it still carries the old name, so the
      // step can run again after a crash.
      const columns = await readTableColumns(db, 'workspace_materialization');

      if (columns.has('dir')) {
        await sql`ALTER TABLE workspace_materialization RENAME COLUMN dir TO directory`.execute(db);
      }
    },
  },
  '040_create_restart_results': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema
        .createTable('restart_results')
        .ifNotExists()
        .addColumn('event_id', 'integer', (column) => column.primaryKey())
        .addColumn('result', 'text', (column) => column.notNull())
        .execute();
    },
  },
  '041_add_fleet_agent_home': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('agent_home', 'text').execute();
    },
  },
  '042_add_fleet_atc_access': {
    async up(db: Kysely<StateStoreSchema>) {
      await db.schema.alterTable('fleet').addColumn('atc_access', 'text').execute();
      await db.schema.alterTable('fleet').addColumn('spawner_session_id', 'text').execute();
    },
  },
};
