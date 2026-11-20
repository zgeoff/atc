import { AtcError } from '@atcx/contract/light';
import type { AuthSetup } from '../auth/create-auth-setup';
import type { HarnessAuthSetup, HarnessSetup } from '../auth/types';
import { applyWorkspaceTrust } from './apply-workspace-trust';
import type { SpawnRollback } from './create-spawn-rollback';
import { createSpawnWorkspace } from './create-spawn-workspace';
import type { SpawnWorkspaceDeps } from './create-spawn-workspace';
import { pickSpawnName } from './pick-spawn-name';
import type { SpawnSteps } from './run-spawn-steps';
import type { SessionCallbacks } from './session-callbacks';
import type { MaterializedSpawn } from './spawn-materializer';
import type { SpawnRequest } from './spawn-request';

interface SpawnSetupDeps extends SpawnWorkspaceDeps {
  readonly rollback: Pick<
    SpawnRollback,
    'destroyFailedSpawnHost' | 'removeLocalTrust' | 'removeSpawnWorkspace' | 'shouldTakeHost'
  >;
  readonly auth: Pick<AuthSetup, 'requireProjectSettings' | 'setupHarnessOnHost'>;
  readonly callbacks: Pick<SessionCallbacks, 'findRecords'>;
}

interface SpawnSetup {
  readonly setup: HarnessSetup;
  readonly materialized: MaterializedSpawn | null;
  readonly root: string | null;
  readonly trustedRoot: string | null;
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

  const startDir = materialize === null ? cwd : null;
  let hostSetup: Promise<HarnessSetup> | null = null;
  let attemptID: string | null = null;

  const setupHost = () => {
    hostSetup ??= steps.run(
      'host',
      async () => {
        const setup = await deps.auth.setupHarnessOnHost({
          adapter,
          provider,
          id,
          hostKey,
          target,
          spawnOptions: {
            prompt: spawn.prompt,
            resume: spawn.resume,
            ...spawn.overrides,
            ...(spawn.atcAccess === null ? {} : { atcMCP: true }),
          },
          auth: authSetup,
          cwd: startDir,
          isNewHost: hostKey === id,
          timer,
        });

        attemptID = setup.attemptID;

        return setup;
      },
      async (setup) => {
        if (
          deps.rollback.shouldTakeHost({
            provider,
            id,
            hostKey,
            target,
            attemptID: setup.attemptID,
          })
        ) {
          await deps.rollback.destroyFailedSpawnHost(provider, id, hostKey, setup.attemptID);
        }
      },
    );

    return hostSetup;
  };

  let removeTrust: (() => Promise<void>) | null = null;
  let checked = false;

  const built =
    materialize === null
      ? { materialized: null, root: null }
      : await createSpawnWorkspace(deps, steps, spawn, {
          materialize,
          setupHost,
          state: {
            findAttemptID: () => attemptID,
            isChecked: () => checked,
          },
        });

  const setup = await setupHost();

  if (spawn.trustClonedWorkspace && built.root === null) {
    throw new AtcError('bad_args', 'trustClonedWorkspace requires a successfully cloned workspace');
  }

  const root = built.root;

  if (root !== null && auth !== null) {
    await steps.run('project-settings', () =>
      timer.withStep('project-settings', () =>
        deps.auth.requireProjectSettings({ adapter, provider, hostKey, target, cwd: root }),
      ),
    );
  }

  const trustedRoot = spawn.trustClonedWorkspace ? root : spawn.parentTrustedRoot;

  if (trustedRoot !== null) {
    await steps.run(
      'trust',
      async () => {
        removeTrust = await applyWorkspaceTrust(spawn, trustedRoot);
      },
      () => deps.rollback.removeLocalTrust(removeTrust, id),
    );
  }

  checked = true;

  const records = deps.callbacks.findRecords();
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
                  name: pickSpawnName(spawn, recordDir),
                  transcriptPath: null,
                  provider,
                  host: hostKey,
                  directory: recordDir,
                  workspace: built.materialized?.workspace ?? null,
                  ...(built.materialized === null ? {} : { branch: built.materialized.branch }),
                },
                spawn.scope,
                { spawner: spawn.spawner, scratch: setup.plan.scratch ?? null },
              )

              // A record stored before its copy failed to land is this
              // step's own partial work, so the step takes it back.
              .catch(async (error: unknown) => {
                await records.remove(id);

                throw error;
              }),
          ),
    async () => {
      await deps.callbacks.findRecords()?.remove(id);
    },
  );

  return { setup, materialized: built.materialized, root, trustedRoot, recordPath };
}
