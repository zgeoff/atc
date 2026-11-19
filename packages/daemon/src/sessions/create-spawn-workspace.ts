import { posix } from 'node:path';
import type { HostDirClaims } from './create-host-dir-claims';
import type { SessionRegistry } from './create-session-registry';
import type { SpawnRollback } from './create-spawn-rollback';
import type { SpawnSteps } from './run-spawn-steps';
import type { MaterializedSpawn, SpawnMaterializer } from './spawn-materializer';
import type { SpawnRequest } from './spawn-request';

export interface SpawnWorkspaceDeps {
  readonly registry: Pick<SessionRegistry, 'hasHostLifecycle'>;
  readonly claims: Pick<
    HostDirClaims,
    'claimHostDir' | 'claimMachineDir' | 'removeClaimedDir' | 'resolveHostDir' | 'resolveHostHome'
  >;
  readonly rollback: Pick<SpawnRollback, 'removeSpawnWorkspace' | 'shouldTakeHost'>;
}

interface SpawnWorkspaceState {
  readonly findAttemptID: () => string | null;
  readonly isChecked: () => boolean;
}

interface SpawnWorkspaceSource {
  readonly materialize: SpawnMaterializer;
  readonly setupHost: () => Promise<unknown>;
  readonly state: SpawnWorkspaceState;
}

export async function createSpawnWorkspace(
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
  const directory = spawn.cwd;
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
            hostHome ??= posix.isAbsolute(directory)
              ? ''
              : await timer.withStep('host-home', () =>
                  deps.claims.resolveHostHome(provider, hostKey),
                );

            const base = posix.isAbsolute(directory) ? directory : posix.join(hostHome, directory);
            const candidate = attempt === 1 ? base : `${base}-${attempt}`;

            const landing = await timer.withStep('dir-claim', () => {
              if (deps.registry.hasHostLifecycle(target)) {
                return deps.claims.claimHostDir({
                  provider,
                  id,
                  hostKey,
                  target,
                  directory: candidate,
                  picked: spawn.autoDir && hostKey !== id,
                });
              }

              // Claim the directory before the clone creates it. A removal running at that moment refuses it,
              // and a removal that starts later keeps the directory because it holds a claim.
              deps.claims.claimMachineDir(id, target, candidate, spawn.autoDir);

              return deps.claims.resolveHostDir(provider, null, candidate);
            });

            landed = landing;

            return { host: hostKey, directory: landing };
          },
          removeClaim: (landing) =>
            deps.claims.removeClaimedDir({ provider, id, hostKey, target, directory: landing }),
          timer,
        },
        spawn.execution.identity,
      ),
    async (built) => {
      const root = landed;

      const takesHost = deps.rollback.shouldTakeHost({
        provider,
        id,
        hostKey,
        target,
        attemptID: state.findAttemptID(),
      });

      if (built === null || root === null || (takesHost && state.isChecked())) {
        return;
      }

      if (takesHost) {
        await deps.rollback
          .removeSpawnWorkspace({ provider, id, hostKey, target, root })
          .catch(() => {});

        return;
      }

      await deps.rollback.removeSpawnWorkspace({ provider, id, hostKey, target, root });
    },
  );

  return { materialized, root: materialized === null ? null : landed };
}
