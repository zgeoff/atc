import { join } from 'node:path';
import type { WorkspaceCleanupConfig } from '@atc/config';
import type { ExecutionProvider } from '@atc/plugin-api';
import type { FleetEntry, StateStore, WorkspaceMaterialization } from '@atc/store';
import type { SessionID, WorkspacePrune, WorkspacePruneFolder } from '@atcx/contract';
import { match } from 'ts-pattern';
import { formatError } from '../auth/format-error';
import { buildWorkspaceRootDir } from '../workspace/build-workspace-root-dir';
import { collectPruneCandidates } from './collect-prune-candidates';
import type { SessionManager } from './create-session-manager';
import { isPathWithin } from './is-path-within';
import { pickWorkspaceCleanup } from './pick-workspace-cleanup';
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

// The directory of a session on the daemon's machine that only the stored fleet lists, as the
// machine resolves it, or null when it did not resolve.
interface StoredDir {
  readonly id: SessionID;
  readonly physical: string | null;
}

// One prune's mode, the stored fleet as it read it, and the stored sessions' directories.
interface PruneRun {
  readonly remove: boolean;
  readonly fleet: readonly FleetEntry[];
  readonly storedDirs: readonly StoredDir[];
}

interface ListedSession {
  readonly id: SessionID;
  readonly cwd: string;
  readonly onMachine: boolean;
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

  // the removal resolves the directory of each listed and held session itself, but not of one
  // only the stored fleet lists, which may reach a workspace through a symlink
  const resolveStoredDirs = (
    fleet: readonly FleetEntry[],
    provider: ExecutionProvider | null,
  ): Promise<StoredDir[]> => {
    const live = new Set(
      [...manager.sessions, ...manager.collectHeldSessions()].map((session) => session.id),
    );

    const stored = collectListed(fleet).filter(
      (session) => session.onMachine && !live.has(session.id),
    );

    return Promise.all(
      stored.map(async (session) => {
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

    const directory = checked.directory;

    const result = await runWorkspaceCheck({ provider, host: null, directory, sha: checked.sha });

    const forms = [directory, ...(result.kind === 'checked' ? [result.path] : [])];

    const listedUser = collectListed(run.fleet).find(
      (session) => session.onMachine && forms.some((form) => isPathWithin(session.cwd, form)),
    );

    // a stored directory that did not resolve may lead anywhere, so it keeps the folder
    const storedUser = run.storedDirs.find((stored) => {
      const physical = stored.physical;

      return physical === null || forms.some((form) => isPathWithin(physical, form));
    });

    const plan = pickWorkspaceCleanup({
      check: deps.settings.check,
      directory,
      result,
      user: listedUser?.id ?? storedUser?.id ?? null,
    });

    if (plan.action === 'skip') {
      return null;
    }

    const bytes = await readHostDirBytes(provider, null, plan.path);

    if (plan.action === 'keep') {
      return { verdict: 'keep', kind: 'workspace', path: plan.path, bytes, reasons: plan.reasons };
    }

    if (!run.remove) {
      return { verdict: 'remove', kind: 'workspace', path: plan.path, bytes, found: plan.found };
    }

    const cleanup = await removeCheckedWorkspace({
      manager,
      provider,
      id: row.sessionID,
      hostKey: row.sessionID,
      target: row.target,
      path: plan.path,
      found: plan.found,
    });

    return match(cleanup)
      .returnType<WorkspacePruneFolder | null>()
      .with({ outcome: 'none' }, () => null)
      .with({ outcome: 'removed' }, (removed) => {
        manager.log(
          `atc: prune removed the workspace ${removed.path} of session ${row.sessionID}${removed.found.length === 0 ? '' : `, which held ${removed.found.join('; ')}`}`,
        );

        return {
          verdict: 'remove',
          kind: 'workspace',
          path: removed.path,
          bytes,
          found: removed.found,
        };
      })
      .with({ outcome: 'kept' }, (kept) => {
        manager.log(
          `atc: prune kept the workspace ${kept.path} of session ${row.sessionID}: ${kept.reasons.join('; ')}`,
        );

        return {
          verdict: 'keep',
          kind: 'workspace',
          path: kept.path,
          bytes,
          reasons: kept.reasons,
        };
      })
      .exhaustive();
  };

  const pruneStateFolder = async (id: SessionID, run: PruneRun): Promise<WorkspacePruneFolder> => {
    const path = join(sessionsDir, id);

    const bytes = await deps.readDirBytes(path);

    if (!run.remove) {
      return { verdict: 'remove', kind: 'state', path, bytes, found: [] };
    }

    // a session with the id may have listed or started while the prune checked other folders
    if (isOwned(id, run.fleet)) {
      return { verdict: 'keep', kind: 'state', path, bytes, reasons: [`in use by session ${id}`] };
    }

    try {
      await deps.removeDir(path);
    } catch (error) {
      const reason = `removing it failed: ${formatError(error)}`;

      manager.log(`atc: prune kept the state folder ${path}: ${reason}`);

      return { verdict: 'keep', kind: 'state', path, bytes, reasons: [reason] };
    }

    manager.log(`atc: prune removed the state folder ${path}`);

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

      const storedDirs = await resolveStoredDirs(fleet, machineProvider);

      const run = { remove, fleet, storedDirs };
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

      return { dryRun: !remove, folders };
    },
  };
}
