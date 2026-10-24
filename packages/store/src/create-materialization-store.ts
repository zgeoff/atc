import type { SessionID } from '@atcx/contract';
import { toSessionID } from '@atcx/contract';
import type { Kysely } from 'kysely';
import { parseWithheldEnv } from './parse-withheld-env';
import type { StateStoreSchema } from './sqlite/state-store-schema';
import type { MaterializationUpdate, WorkspaceMaterialization } from './workspace-materialization';

// Each spawn's workspace on its way to the execution target.
export interface MaterializationStore {
  // Records a materialization as it starts, in the resolving phase.
  readonly createMaterialization: (
    row: Pick<
      WorkspaceMaterialization,
      'sessionID' | 'target' | 'directory' | 'sourceKind' | 'withheldEnv'
    >,
    at: number,
  ) => Promise<void>;
  readonly updateMaterialization: (
    sessionID: SessionID,
    fields: MaterializationUpdate,
    at: number,
  ) => Promise<void>;
  readonly readMaterialization: (sessionID: SessionID) => Promise<WorkspaceMaterialization | null>;

  // Runs as a daemon starts, before it serves a request: a materialization
  // short of ready or failed was cut off by a stopped daemon before its
  // workspace was verified.
  readonly reconcileMaterializations: (at: number) => Promise<void>;
}

export function createMaterializationStore(db: Kysely<StateStoreSchema>): MaterializationStore {
  return {
    createMaterialization: async (row, at) => {
      await db
        .insertInto('workspace_materialization')
        .values({
          session_id: row.sessionID,
          target: row.target,
          directory: row.directory,
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
    },

    updateMaterialization: async (sessionID, fields, at) => {
      await db
        .updateTable('workspace_materialization')
        .set({
          phase: fields.phase,
          ...(fields.directory === undefined ? {} : { directory: fields.directory }),
          ...(fields.repoURL === undefined ? {} : { repo_url: fields.repoURL }),
          ...(fields.sha === undefined ? {} : { sha: fields.sha }),
          ...(fields.ref === undefined ? {} : { ref: fields.ref }),
          ...(fields.errorCode === undefined ? {} : { error_code: fields.errorCode }),
          ...(fields.materializedAt === undefined
            ? {}
            : { materialized_at: fields.materializedAt }),
          updated_at: at,
        })
        .where('session_id', '=', sessionID)
        .execute();
    },

    readMaterialization: async (sessionID) => {
      const row = await db
        .selectFrom('workspace_materialization')
        .selectAll()
        .where('session_id', '=', sessionID)
        .executeTakeFirst();

      return row === undefined ? null : toWorkspaceMaterialization(row);
    },

    reconcileMaterializations: async (at) => {
      await db
        .updateTable('workspace_materialization')
        .set({ phase: 'failed', error_code: 'workspace_interrupted', updated_at: at })
        .where('phase', 'not in', ['ready', 'failed'])
        .execute();
    },
  };
}

function toWorkspaceMaterialization(
  row: Readonly<StateStoreSchema['workspace_materialization']>,
): WorkspaceMaterialization {
  const withheldEnv = parseWithheldEnv(row.withheld_env);

  // Reading the workspace as withholding nothing would start its agent with
  // the variables it withheld.
  if (withheldEnv === null) {
    throw new Error(
      `the workspace of session '${row.session_id}' holds a malformed list of withheld variables`,
    );
  }

  return {
    sessionID: toSessionID(row.session_id),
    target: row.target,
    directory: row.directory,
    sourceKind: row.source_kind,
    phase: row.phase,
    repoURL: row.repo_url,
    sha: row.sha,
    ref: row.ref,
    errorCode: row.error_code,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    materializedAt: row.materialized_at,
    withheldEnv,
  };
}
