import { posix } from 'node:path';
import type { HostDirClaims } from './host-dir-claims';
import type { SpawnSteps } from './run-spawn-steps';
import type { SessionRegistry } from './session-registry';
import type { MaterializedSpawn, SpawnMaterializer } from './spawn-materializer';
import type { SpawnRequest } from './spawn-request';
import type { SpawnRollback } from './spawn-rollback';

export interface SpawnWorkspaceDeps {
  readonly registry: Pick<SessionRegistry, 'hasHostLifecycle'>;
  readonly claims: Pick<
    HostDirClaims,
    'claimHostDir' | 'removeClaimedDir' | 'resolveHostDir' | 'resolveHostHome'
  >;
  readonly rollback: Pick<SpawnRollback, 'removeSpawnWorkspace' | 'shouldTakeHost'>;
}

// What the workspace's undo reads from the steps after it: the auth
// attempt the host was set up with, and whether the workspace passed its
// project-settings check and its trust.
interface SpawnWorkspaceState {
  readonly findAttemptID: () => string | null;
  readonly isChecked: () => boolean;
}

interface SpawnWorkspaceSource {
  readonly materialize: SpawnMaterializer;
  readonly setupHost: () => Promise<unknown>;
  readonly state: SpawnWorkspaceState;
}

export async function buildSpawnWorkspace(
  deps: SpawnWorkspaceDeps,
  steps: SpawnSteps,
  spawn: Readonly<SpawnRequest>,
  source: SpawnWorkspaceSource,
): Promise<{ readonly materialized: MaterializedSpawn | null; readonly root: string | null }> {
  const materialize = source.materialize;
  const setupHost = source.setupHost;
  const state = source.state;
  const provider = spawn.provider;
  const id = spawn.id;
  const hostKey = spawn.hostKey;
  const target = spawn.target;
  const timer = spawn.timer;
  const dir = spawn.cwd;
  let landed: string | null = null;
  let hostHome: string | null = null;

  const materialized = await steps.run(
    'workspace',
    () =>
      materialize(
        {
          readyHost: async (attempt) => {
            await setupHost();

            // A directory the daemon picked on a remote target is relative
            // to the home there, which only the readied host can resolve.
            hostHome ??= posix.isAbsolute(dir)
              ? ''
              : await timer.withStep('host-home', () =>
                  deps.claims.resolveHostHome(provider, hostKey),
                );

            const base = posix.isAbsolute(dir) ? dir : posix.join(hostHome, dir);
            const candidate = attempt === 1 ? base : `${base}-${attempt}`;

            const landing = await timer.withStep('dir-claim', () =>
              deps.registry.hasHostLifecycle(target)
                ? deps.claims.claimHostDir(
                    provider,
                    id,
                    hostKey,
                    target,
                    candidate,
                    spawn.autoDir && hostKey !== id,
                  )
                : deps.claims.resolveHostDir(provider, null, candidate),
            );

            landed = landing;

            return { host: hostKey, dir: landing };
          },
          removeClaim: (landing) =>
            deps.claims.removeClaimedDir(provider, id, hostKey, target, landing),
          timer,
        },
        spawn.execution.identity,
      ),
    async (built) => {
      const root = landed;

      const takesHost = deps.rollback.shouldTakeHost(
        provider,
        id,
        hostKey,
        target,
        state.findAttemptID(),
      );

      // when the host's undo takes the host back, the directory goes with
      // it: a checked workspace is skipped, and a failed removal of an
      // unchecked one does not stop the unwind
      if (built === null || root === null || (takesHost && state.isChecked())) {
        return;
      }

      if (takesHost) {
        await deps.rollback
          .removeSpawnWorkspace(provider, id, hostKey, target, root)
          .catch(() => {});

        return;
      }

      await deps.rollback.removeSpawnWorkspace(provider, id, hostKey, target, root);
    },
  );

  return { materialized, root: materialized === null ? null : landed };
}
