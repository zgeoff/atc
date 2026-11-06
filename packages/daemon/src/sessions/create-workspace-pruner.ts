import { join } from 'node:path';
import type { WorkspaceCleanupConfig } from '@atc/config';
import type { ExecutionProvider } from '@atc/plugin-api';
import type { FleetEntry, StateStore, WorkspaceMaterialization } from '@atc/store';
import type { SessionID, WorkspacePrune, WorkspacePruneFolder } from '@atcx/contract';
import { match } from 'ts-pattern';
import { formatError } from '../auth/format-error';
import { buildWorkspaceRootDir } from '../workspace/build-workspace-root-dir';
import { collectPruneCandidates } from './collect-prune-candidates';
import type { ListedSession } from './collect-prune-candidates';
import type { SessionManager } from './create-session-manager';
import { pickPruneStatePlan } from './pick-prune-state-plan';
import { pickPruneWorkspacePlan } from './pick-prune-workspace-plan';
import type { PruneWorkspacePlan, ResolvedDir } from './pick-prune-workspace-plan';
import { pickWorkspaceEligibility } from './pick-workspace-eligibility';
import type { WorkspaceEligibility } from './pick-workspace-eligibility';
import { readHostDirBytes } from './read-host-dir-bytes';
import { readHostSubdirs } from './read-host-subdirs';
import { removeCheckedWorkspace } from './remove-checked-workspace';
import { runWorkspaceCheck } from './run-workspace-check';

interface WorkspacePrunerDeps {
  readonly manager: Pick<
    SessionManager,
    | 'sessions'
    | 'collectHeldSessions'
    | 'spawning'
    | 'hasHostLifecycle'
    | 'findExecutionRefusal'
    | 'requireExecution'
    | 'removeClaimedDir'
    | 'resolveHostDir'
    | 'withRemovalHold'
    | 'log'
  >;
  readonly store: Pick<StateStore, 'loadFleet' | 'readMaterializations'>;

  // The ids of the targets the config holds.
  readonly targets: readonly string[];

  // The workspaces root of each target, as a spawn picks it.
  readonly workspaceRoots: Readonly<{
    root: string | null;
    targetRoots: ReadonlyMap<string, string>;
  }>;
  readonly homeDir: string;

  // The daemon's state folder, which holds each session's own folder under `sessions/`.
  readonly stateDir: string;

  // The names of the folders directly under a folder on the daemon's host, and of no symlink;
  // none when the folder is not there.
  readonly readSubdirNames: (directory: string) => Promise<string[]>;
  readonly readDirBytes: (directory: string) => Promise<number | null>;

  // Removes a folder on the daemon's host and everything in it; a folder already gone is no error.
  readonly removeDir: (directory: string) => Promise<void>;

  readonly settings: WorkspaceCleanupConfig;
}

export interface WorkspacePruner {
  // Without remove, a dry run that reports what a prune with remove would take away.
  readonly prune: (remove: boolean) => Promise<WorkspacePrune>;
}

// One prune's mode, the stored fleet as it read it, and the listed sessions' resolved directories.
interface PruneRun {
  readonly remove: boolean;
  readonly fleet: readonly FleetEntry[];
  readonly resolvedDirs: readonly ResolvedDir[];
}

export function createWorkspacePruner(deps: WorkspacePrunerDeps): WorkspacePruner {
  const manager = deps.manager;
  const sessionsDir = join(deps.stateDir, 'sessions');

  // The sessions the fleet lists now, the ones a kill or forget still holds, and the ones the
  // fleet listed when the prune read it, which a forget since then may have taken off the list.
  const collectListed = (fleet: readonly FleetEntry[]): ListedSession[] =>
    [
      ...[...manager.sessions, ...manager.collectHeldSessions()].map((session) => ({
        id: session.id,
        cwd: session.cwd,
        target: session.target,
      })),
      ...fleet.map((entry) => ({
        id: entry.sessionID,
        cwd: entry.cwd,
        target: entry.target ?? 'local',
      })),
    ].map((session) => ({
      id: session.id,
      cwd: session.cwd,
      onMachine: !manager.hasHostLifecycle(session.target),
    }));

  // a session may reach a workspace through a symlink, which only its resolved directory shows
  const resolveListedDirs = (
    fleet: readonly FleetEntry[],
    provider: ExecutionProvider | null,
  ): Promise<ResolvedDir[]> => {
    const onMachine = collectListed(fleet).filter((session) => session.onMachine);

    return Promise.all(
      onMachine.map(async (session) => {
        const physical =
          provider === null
            ? null
            : await manager.resolveHostDir(provider, null, session.cwd).catch(() => null);

        return { id: session.id, physical };
      }),
    );
  };

  const isOwned = (id: SessionID, fleet: readonly FleetEntry[]): boolean =>
    manager.spawning.has(id) || collectListed(fleet).some((session) => session.id === id);

  const findProvider = (target: string): ExecutionProvider | null =>
    manager.findExecutionRefusal({ target, targetIdentity: null }, 'run') === null
      ? manager.requireExecution({ target, targetIdentity: null }, 'run').provider
      : null;

  const readRootFolders = (target: string): Promise<string[]> => {
    const provider = findProvider(target);

    if (provider === null) {
      return Promise.resolve([]);
    }

    const root = buildWorkspaceRootDir({
      root: deps.workspaceRoots.targetRoots.get(target) ?? deps.workspaceRoots.root,
      remote: provider.remote,
      home: deps.homeDir,
    });

    // a root relative to a remote home has no absolute form here to compare rows against
    return root.startsWith('/') ? readHostSubdirs(provider, null, root) : Promise.resolve([]);
  };

  const pruneWorkspace = (
    row: WorkspaceMaterialization,
    run: PruneRun,
  ): Promise<WorkspacePruneFolder | null> => {
    const refusal = manager.findExecutionRefusal(
      { target: row.target, targetIdentity: null },
      'run',
    );

    const eligibility = pickWorkspaceEligibility({
      row,
      target: row.target,
      harnessEnded: true,
      bindingRefusal: refusal?.message ?? null,
    });

    return match(eligibility)
      .returnType<Promise<WorkspacePruneFolder | null>>()
      .with({ kind: 'none' }, () => Promise.resolve(null))
      .with({ kind: 'kept' }, (kept) =>
        Promise.resolve({
          verdict: 'keep',
          kind: 'workspace',
          path: kept.path,
          bytes: null,
          reasons: [kept.reason],
        }),
      )
      .with({ kind: 'check' }, (checked) => {
        const check = () => checkWorkspace(row, checked, run);

        // the hold starts before the check, since a session that starts in the folder while the
        // check runs would find its work removed
        return run.remove
          ? manager.withRemovalHold(
              {
                id: row.sessionID,
                hostKey: row.sessionID,
                target: row.target,
                directory: checked.directory,
              },
              check,
            )
          : check();
      })
      .exhaustive();
  };

  const checkWorkspace = async (
    row: WorkspaceMaterialization,
    checked: Extract<WorkspaceEligibility, { kind: 'check' }>,
    run: PruneRun,
  ): Promise<WorkspacePruneFolder | null> => {
    const provider = manager.requireExecution(
      { target: row.target, targetIdentity: null },
      'run',
    ).provider;

    const result = await runWorkspaceCheck({
      provider,
      host: null,
      directory: checked.directory,
      sha: checked.sha,
    });

    const plan = pickPruneWorkspacePlan({
      check: deps.settings.check,
      directory: checked.directory,
      result,
      listed: collectListed(run.fleet),
      resolvedDirs: run.resolvedDirs,
      remove: run.remove,
    });

    if (plan.action === 'skip') {
      return null;
    }

    const bytes = await readHostDirBytes(provider, null, plan.path);

    return match(plan)
      .returnType<Promise<WorkspacePruneFolder | null>>()
      .with({ action: 'keep' }, (kept) =>
        Promise.resolve({
          verdict: 'keep',
          kind: 'workspace',
          path: kept.path,
          bytes,
          reasons: kept.reasons,
        }),
      )
      .with({ action: 'report' }, (report) =>
        Promise.resolve({
          verdict: 'remove',
          kind: 'workspace',
          path: report.path,
          bytes,
          found: report.found,
        }),
      )
      .with({ action: 'remove' }, (removal) => removeWorkspace(row, provider, removal, bytes))
      .exhaustive();
  };

  const removeWorkspace = async (
    row: WorkspaceMaterialization,
    provider: ExecutionProvider,
    removal: Extract<PruneWorkspacePlan, { action: 'remove' }>,
    bytes: number | null,
  ): Promise<WorkspacePruneFolder | null> => {
    const cleanup = await removeCheckedWorkspace({
      manager,
      provider,
      id: row.sessionID,
      hostKey: row.sessionID,
      target: row.target,
      path: removal.path,
      found: removal.found,
    });

    return match(cleanup)
      .returnType<WorkspacePruneFolder | null>()
      .with({ outcome: 'none' }, () => null)
      .with({ outcome: 'removed' }, (removed) => ({
        verdict: 'remove',
        kind: 'workspace',
        path: removed.path,
        bytes,
        found: removed.found,
      }))
      .with({ outcome: 'kept' }, (kept) => ({
        verdict: 'keep',
        kind: 'workspace',
        path: kept.path,
        bytes,
        reasons: kept.reasons,
      }))
      .exhaustive();
  };

  const pruneStateFolder = async (id: SessionID, run: PruneRun): Promise<WorkspacePruneFolder> => {
    const path = join(sessionsDir, id);

    const bytes = await deps.readDirBytes(path);

    // a session with the id may have listed or started while the prune checked other folders
    const plan = pickPruneStatePlan({ remove: run.remove, owned: isOwned(id, run.fleet) });

    if (plan === 'report') {
      return { verdict: 'remove', kind: 'state', path, bytes, found: [] };
    }

    if (plan === 'keep') {
      return { verdict: 'keep', kind: 'state', path, bytes, reasons: [`in use by session ${id}`] };
    }

    try {
      await deps.removeDir(path);
    } catch (error) {
      const reason = `removing it failed: ${formatError(error)}`;

      return { verdict: 'keep', kind: 'state', path, bytes, reasons: [reason] };
    }

    return { verdict: 'remove', kind: 'state', path, bytes, found: [] };
  };

  return {
    prune: async (remove) => {
      const permanent = deps.targets.filter((target) => !manager.hasHostLifecycle(target));

      const fleet = await deps.store.loadFleet();
      const rows = await deps.store.readMaterializations();
      const rootFolders = await Promise.all(permanent.map((target) => readRootFolders(target)));
      const stateFolders = await deps.readSubdirNames(sessionsDir);

      // the listed sessions and the spawns in flight are read in the same turn as the candidates
      const candidates = collectPruneCandidates({
        rows,
        permanentTargets: new Set(permanent),
        listed: collectListed(fleet),
        spawning: manager.spawning,
        rootFolders: rootFolders.flat(),
        stateFolders,
      });

      const machineProvider = permanent.map((target) => findProvider(target)).find(Boolean) ?? null;

      const resolvedDirs = await resolveListedDirs(fleet, machineProvider);

      const run = { remove, fleet, resolvedDirs };
      const folders: WorkspacePruneFolder[] = [];

      for (const row of candidates.workspaces) {
        const folder = await pruneWorkspace(row, run);

        if (folder !== null) {
          folders.push(folder);
        }
      }

      for (const skipped of candidates.skipped) {
        folders.push({ verdict: 'skip', kind: 'workspace', ...skipped });
      }

      for (const id of candidates.states) {
        const folder = await pruneStateFolder(id, run);

        folders.push(folder);
      }

      if (remove) {
        for (const folder of folders) {
          logPrunedFolder(manager.log, folder);
        }
      }

      return { dryRun: !remove, folders };
    },
  };
}

function logPrunedFolder(log: (line: string) => void, folder: WorkspacePruneFolder): void {
  const name = folder.kind === 'state' ? 'state folder' : 'workspace';

  match(folder)
    .with({ verdict: 'skip' }, () => {})
    .with({ verdict: 'remove' }, (removed) => {
      log(
        `atc: prune removed the ${name} ${removed.path}${removed.found.length === 0 ? '' : `, which held ${removed.found.join('; ')}`}`,
      );
    })
    .with({ verdict: 'keep' }, (kept) => {
      log(`atc: prune kept the ${name} ${kept.path}: ${kept.reasons.join('; ')}`);
    })
    .exhaustive();
}
