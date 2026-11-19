import { parseJSONStrings, systemClock, toAgentID } from '@atc/core';
import type { DaemonID, GrantScope, SessionID, SessionWorkspace } from '@atcx/contract';
import { GRANT_SCOPES, toAgentSessionID, toDaemonID, toSessionID } from '@atcx/contract';
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import { buildFleetWithoutReplacedRows } from '../fleet/build-fleet-without-replaced-rows';
import { findReplacement } from '../fleet/find-replacement';
import type { FleetEntry, FleetStore } from '../fleet/fleet-entry';
import { StaleOwnershipError } from '../fleet/stale-ownership-error';
import type { StateStoreSchema } from '../sqlite/state-store-schema';
import { parseWithheldEnv } from '../utils/parse-withheld-env';

const OWNER_EPOCH = 1;

export function createFleetStore(db: Kysely<StateStoreSchema>, daemonID: DaemonID): FleetStore {
  return {
    daemonID,

    loadFleet: async () => {
      const rows = await db
        .selectFrom('fleet')

        // A session's ready workspace comes back with its row.
        .leftJoin('workspace_materialization as workspace', (join) =>
          join
            .onRef('workspace.session_id', '=', 'fleet.session_id')
            .on('workspace.phase', '=', 'ready'),
        )
        .where('fleet.session_id', 'in', (eb) =>
          eb.selectFrom('session_owner').select('session_id').where('daemon_id', '=', daemonID),
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
          'fleet.plugin_dirs',
          'fleet.target',
          'fleet.target_identity',
          'workspace.repo_url',
          'workspace.sha',
          'workspace.ref',
          'workspace.materialized_at',
          'workspace.withheld_env',
          'fleet.desired',
          'fleet.host_key',
          'fleet.auth_revision',
          'fleet.agent_home',
          'fleet.suspended',
          'fleet.atc_access',
          'fleet.spawner_session_id',
          'fleet.trusted_root',
        ])
        .execute();

      const entries: FleetEntry[] = [];

      for (const row of rows) {
        const withheldEnv = parseWithheldEnv(row.withheld_env);

        // A session whose withheld variables cannot be read stays out of the
        // fleet, so its agent never starts with the variables it withheld; its
        // row stays stored, since a fleet write keeps rows it never loaded.
        if (withheldEnv === null) {
          continue;
        }

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
          ...buildPluginDirsField(row.plugin_dirs),
          ...(row.target === null ? {} : { target: row.target }),
          ...(row.target_identity === null ? {} : { targetIdentity: row.target_identity }),
          ...buildWorkspaceField(row),
          ...(withheldEnv.length === 0 ? {} : { withheldEnv }),
          ...(row.desired === 'sleep' || row.desired === 'stop' ? { desired: row.desired } : {}),
          ...(row.host_key === null ? {} : { hostKey: toSessionID(row.host_key) }),
          ...(row.auth_revision === null ? {} : { authRevision: row.auth_revision }),
          ...(row.agent_home === null ? {} : { agentHome: row.agent_home }),
          ...(row.suspended === 1 ? { suspended: true } : {}),
          ...buildAtcAccessField(row.atc_access),
          ...(row.spawner_session_id === null
            ? {}
            : { spawner: toSessionID(row.spawner_session_id) }),
          ...(row.trusted_root === null ? {} : { trustedRoot: row.trusted_root }),
        });
      }

      return entries;
    },

    writeFleet: async (entries, removed = []) => {
      const kept = buildFleetWithoutReplacedRows(entries);
      const sessionIDs = [...entries.map((entry) => entry.sessionID), ...removed];

      const agentSessionIDs = entries.flatMap((entry) =>
        entry.agentSessionID === undefined ? [] : [entry.agentSessionID],
      );

      const writtenIndex = new Map(entries.map((entry, index) => [entry.sessionID, index]));
      const keptByID = new Map(kept.map((entry) => [entry.sessionID, entry]));

      await db.transaction().execute(async (trx) => {
        await requireCurrentOwnership(
          trx,
          daemonID,
          entries.map((entry) => entry.sessionID),
        );

        const candidates =
          agentSessionIDs.length === 0
            ? []
            : await trx
                .selectFrom('fleet')
                .select(['session_id', 'agent_session_id', 'exited', 'target', 'target_identity'])
                .where('agent_session_id', 'in', agentSessionIDs)
                .execute();

        const replaced = candidates.flatMap((row) => {
          const index = writtenIndex.get(toSessionID(row.session_id));
          const written = index === undefined ? undefined : entries[index];

          const replacement =
            index === undefined || written === undefined
              ? findReplacement(
                  {
                    ...(row.agent_session_id === null
                      ? {}
                      : { agentSessionID: toAgentSessionID(row.agent_session_id) }),
                    exited: row.exited === 1,
                    ...(row.target === null ? {} : { target: row.target }),
                    ...(row.target_identity === null
                      ? {}
                      : { targetIdentity: row.target_identity }),
                  },
                  entries,
                  0,
                )
              : findReplacement(written, entries, index + 1);

          const survivor =
            replacement === undefined ? undefined : keptByID.get(replacement.sessionID);

          return survivor === undefined ? [] : [{ sessionID: row.session_id, survivor }];
        });

        const dropped = [...new Set([...sessionIDs, ...replaced.map((row) => row.sessionID)])];

        if (dropped.length > 0) {
          await trx
            .deleteFrom('fleet')
            .where('session_id', 'in', dropped)
            .where('session_id', 'in', (eb) =>
              eb.selectFrom('session_owner').select('session_id').where('daemon_id', '=', daemonID),
            )
            .execute();

          await trx
            .deleteFrom('session_owner')
            .where('daemon_id', '=', daemonID)
            .where('session_id', 'in', dropped)
            .execute();
        }

        const updatedAt = systemClock.now();

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
              plugin_dirs:
                entry.pluginDirs === undefined || entry.pluginDirs.length === 0
                  ? null
                  : JSON.stringify(entry.pluginDirs),
              target: entry.target ?? null,
              target_identity: entry.targetIdentity ?? null,
              desired: entry.desired ?? null,
              host_key: entry.hostKey ?? null,
              auth_revision: entry.authRevision ?? null,
              agent_home: entry.agentHome ?? null,
              suspended: entry.suspended === true ? 1 : 0,
              atc_access:
                entry.atcAccess === undefined || entry.atcAccess.length === 0
                  ? null
                  : JSON.stringify(entry.atcAccess),
              spawner_session_id: entry.spawner ?? null,
              trusted_root: entry.trustedRoot ?? null,
            })
            .execute();

          await trx
            .insertInto('session_owner')
            .values({
              session_id: entry.sessionID,
              daemon_id: daemonID,
              owner_epoch: OWNER_EPOCH,
              updated_at: updatedAt,
            })
            .execute();
        }

        for (const row of replaced) {
          await trx
            .updateTable('fleet')
            .set({ parent_session_id: row.survivor.parent ?? row.survivor.sessionID })
            .where('parent_session_id', '=', row.sessionID)
            .where('session_id', 'in', (eb) =>
              eb.selectFrom('session_owner').select('session_id').where('daemon_id', '=', daemonID),
            )
            .execute();
        }
      });
    },

    updateFleetEntry: async (sessionID, fields) => {
      const values = {
        ...(fields.result === undefined ? {} : { result: fields.result }),
        ...(fields.transcriptPath === undefined ? {} : { transcript_path: fields.transcriptPath }),
      };

      if (Object.keys(values).length === 0) {
        return;
      }

      await db.transaction().execute(async (trx) => {
        await requireCurrentOwnership(trx, daemonID, [sessionID]);

        await trx.updateTable('fleet').set(values).where('session_id', '=', sessionID).execute();
      });
    },

    readAgentSessionHolders: async (agentSessionID) => {
      const rows = await db
        .selectFrom('fleet')
        .select(['session_id', 'host_key'])
        .where('agent_session_id', '=', agentSessionID)
        .execute();

      return rows.map((row) => ({
        sessionID: toSessionID(row.session_id),
        hostKey: toSessionID(row.host_key ?? row.session_id),
      }));
    },
  };
}

// A session without its plugins still runs, so an unreadable stored list loads none.
function buildPluginDirsField(stored: string | null): { readonly pluginDirs?: string[] } {
  const dirs = stored === null ? null : parseJSONStrings(stored);

  return dirs === null || dirs.length === 0 ? {} : { pluginDirs: dirs };
}

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

function buildAtcAccessField(stored: string | null): { readonly atcAccess?: GrantScope[] } {
  const scopes = (stored === null ? null : parseJSONStrings(stored)) ?? [];
  const granted = GRANT_SCOPES.filter((scope) => scopes.includes(scope));

  return granted.length === 0 || granted.length !== scopes.length ? {} : { atcAccess: granted };
}

async function requireCurrentOwnership(
  trx: Transaction<StateStoreSchema>,
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
    throw new StaleOwnershipError({
      sessionID: toSessionID(stale.session_id),
      ownerDaemonID: toDaemonID(stale.daemon_id),
      ownerEpoch: stale.owner_epoch,
      writerDaemonID: daemonID,
      writerEpoch: OWNER_EPOCH,
    });
  }
}
