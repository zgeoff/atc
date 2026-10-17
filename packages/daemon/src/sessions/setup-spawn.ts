import { DaemonError } from '@atc/protocol/wire';
import type { AuthSetup, HarnessAuthSetup, HarnessSetup } from '../auth/auth-setup';
import { applyWorkspaceTrust } from './apply-workspace-trust';
import { buildSpawnWorkspace } from './build-spawn-workspace';
import type { SpawnWorkspaceDeps } from './build-spawn-workspace';
import type { SpawnSteps } from './run-spawn-steps';
import type { SessionCallbacks } from './session-callbacks';
import type { MaterializedSpawn } from './spawn-materializer';
import type { SpawnRequest } from './spawn-request';
import type { SpawnRollback } from './spawn-rollback';

interface SpawnSetupDeps extends SpawnWorkspaceDeps {
  readonly rollback: Pick<
    SpawnRollback,
    'destroyFailedSpawnHost' | 'removeLocalTrust' | 'removeSpawnWorkspace' | 'shouldTakeHost'
  >;
  readonly auth: Pick<AuthSetup, 'requireProjectSettings' | 'setupHarnessOnHost'>;
  readonly callbacks: Pick<SessionCallbacks, 'getRecords'>;
}

// What a spawn readied before its harness starts: the host's setup, the
// built workspace and its root, and the path of the published record.
interface SpawnSetup {
  readonly setup: HarnessSetup;
  readonly materialized: MaterializedSpawn | null;
  readonly root: string | null;
  readonly recordPath: string | null;
}

export async function setupSpawn(
  deps: SpawnSetupDeps,
  steps: SpawnSteps,
  spawn: Readonly<SpawnRequest>,
): Promise<SpawnSetup> {
  const adapter = spawn.adapter;
  const provider = spawn.provider;
  const auth = spawn.auth;
  const id = spawn.id;
  const hostKey = spawn.hostKey;
  const target = spawn.target;
  const cwd = spawn.cwd;
  const timer = spawn.timer;
  const materialize = spawn.materialize;

  const authSetup: HarnessAuthSetup | null =
    auth === null
      ? null
      : {
          ...auth,
          mode: hostKey === id ? 'create' : 'verify',
          targetIdentity: spawn.execution.identity,
        };

  // A spawn that builds its workspace reads the workspace's project
  // settings once it is built, not when the host is readied before it.
  const startDir = materialize === null ? cwd : null;

  // The host is set up once, when the workspace's source resolves or, for
  // a directory that runs as it stands, before the harness starts. Its
  // undo takes back the host when the spawn readied it for itself.
  let hostSetup: Promise<HarnessSetup> | null = null;
  let attemptID: string | null = null;

  const setupHost = () => {
    hostSetup ??= steps.run(
      'host',
      async () => {
        const setup = await deps.auth.setupHarnessOnHost(
          adapter,
          provider,
          id,
          hostKey,
          target,
          { prompt: spawn.prompt, resume: spawn.resume, ...spawn.overrides },
          authSetup,
          startDir,
          hostKey === id,
          timer,
        );

        attemptID = setup.attemptID;

        return setup;
      },
      async (setup) => {
        if (deps.rollback.shouldTakeHost(provider, id, hostKey, target, setup.attemptID)) {
          await deps.rollback.destroyFailedSpawnHost(provider, id, hostKey, setup.attemptID);
        }
      },
    );

    return hostSetup;
  };

  // Takes back trust a spawn accepted in the user's own agent config.
  let removeTrust: (() => Promise<void>) | null = null;

  // Whether the workspace passed its project-settings check and its trust.
  let checked = false;

  const built =
    materialize === null
      ? { materialized: null, root: null }
      : await buildSpawnWorkspace(deps, steps, spawn, {
          materialize,
          setupHost,
          state: {
            findAttemptID: () => attemptID,
            isChecked: () => checked,
          },
        });

  const setup = await setupHost();

  if (spawn.trustClonedWorkspace && built.root === null) {
    throw new DaemonError(
      'bad_args',
      'trustClonedWorkspace requires a successfully cloned workspace',
    );
  }

  const root = built.root;

  // A launch behind the broker reads the project settings of the clone
  // it starts in, once the clone is on the host and before it is trusted.
  if (root !== null && auth !== null) {
    await steps.run('project-settings', () =>
      timer.withStep('project-settings', () =>
        deps.auth.requireProjectSettings(adapter, provider, hostKey, target, root),
      ),
    );
  }

  if (root !== null && spawn.trustClonedWorkspace) {
    await steps.run(
      'trust',
      async () => {
        removeTrust = await applyWorkspaceTrust(spawn, root);
      },
      () => deps.rollback.removeLocalTrust(removeTrust, id),
    );
  }

  checked = true;

  const records = deps.callbacks.getRecords();
  const recordDir = spawn.autoDir && root !== null ? root : cwd;

  const recordPath = await steps.run(
    'record',
    () =>
      records === null
        ? null
        : timer.withStep('record', () =>
            records
              .createRecord(
                {
                  session: id,
                  target,
                  provider,
                  host: hostKey,
                  dir: recordDir,
                  workspace: built.materialized?.workspace ?? null,
                  ...(built.materialized === null ? {} : { branch: built.materialized.branch }),
                },
                spawn.scope,
              )

              // A record stored before its copy failed to land is this
              // step's own partial work, so the step takes it back.
              .catch(async (error: unknown) => {
                await records.remove(id);

                throw error;
              }),
          ),
    async () => {
      await deps.callbacks.getRecords()?.remove(id);
    },
  );

  return { setup, materialized: built.materialized, root, recordPath };
}
