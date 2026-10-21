import { socketPath } from '@atc/config';
import type { AgentID, AgentSessionID, SessionID } from '@atc/core';
import { createStepTimer } from '@atc/core';
import type { SpawnOverrides } from '@atc/plugin-api';
import { EffectRemainsError } from '@atc/plugin-api';
import type { DeclaredScope } from '@atc/protocol';
import { buildSessionEnv } from '@atc/protocol/session';
import { DaemonError } from '@atc/protocol/wire';
import type { AuthSetup } from '../auth/create-auth-setup';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import type { HostDirClaims } from './create-host-dir-claims';
import type { SessionHarnesses, SpawnReadied } from './create-session-harnesses';
import type { SessionRegistry } from './create-session-registry';
import type { SpawnRollback } from './create-spawn-rollback';
import { mintSessionID } from './mint-session-id';
import { pickSpawnName } from './pick-spawn-name';
import { resolveRepoRoot } from './resolve-repo-root';
import { runSpawnSteps } from './run-spawn-steps';
import type { SpawnStepRunner, SpawnSteps } from './run-spawn-steps';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import { setupSpawn } from './setup-spawn';
import type { SpawnMaterializer } from './spawn-materializer';
import type { SpawnRequest } from './spawn-request';

interface SessionSpawnerDeps {
  readonly registry: Pick<
    SessionRegistry,
    'sessions' | 'targets' | 'findAdapter' | 'requireExecution' | 'hasHostLifecycle'
  >;
  readonly fleet: Pick<SessionFleetWriter, 'tryWriteFleet' | 'writeStatus'>;
  readonly claims: Pick<
    HostDirClaims,
    | 'claimHostDir'
    | 'claimMachineDir'
    | 'claimPlainDir'
    | 'claimWorkspace'
    | 'releaseWorkspace'
    | 'removeClaimedDir'
    | 'resolveHostDir'
    | 'resolveHostHome'
  >;
  readonly harnesses: Pick<
    SessionHarnesses,
    | 'startingSpawns'
    | 'attachHarness'
    | 'mintBridgeBinding'
    | 'waitForAuthStart'
    | 'withHostReadying'
  >;
  readonly rollback: Pick<
    SpawnRollback,
    | 'destroyFailedSpawnHost'
    | 'removeListedSpawn'
    | 'removeLocalTrust'
    | 'removeSpawnWorkspace'
    | 'rollingBack'
    | 'shouldTakeHost'
  >;
  readonly auth: Pick<
    AuthSetup,
    | 'buildBrokerSpec'
    | 'requireAuthBinder'
    | 'requireProjectSettings'
    | 'requireSharedBinding'
    | 'resolveHarnessAuth'
    | 'setupHarnessOnHost'
  >;
  readonly callbacks: Pick<
    SessionCallbacks,
    | 'onBoot'
    | 'onEvent'
    | 'onRelay'
    | 'log'
    | 'now'
    | 'getClock'
    | 'findRecords'
    | 'startMessageBridge'
    | 'stopMessageBridge'
  >;

  // Runs each spawn's steps and unwinds them on a failure; the spawn steps
  // runner when unset.
  readonly runSteps?: SpawnStepRunner;
}

export interface SessionSpawner {
  // resume: true opens the agent's session picker, an id resumes that session;
  // the session keeps overrides for every revive; a materialize failure takes
  // back the host the spawn readied, unless it is a parent's
  readonly spawn: (
    cwd: string,
    name: string,
    prompt: string,
    cols: number,
    rows: number,
    resume?: boolean | AgentSessionID,
    namedBy?: 'user' | 'auto',
    agent?: AgentID,
    parent?: SessionID | null,
    overrides?: SpawnOverrides,
    id?: SessionID,
    target?: string,
    materialize?: SpawnMaterializer | null,
    requireInReach?: () => void,
    autoDir?: boolean,
    scope?: DeclaredScope | null,
    answer?: ((session: Session) => void) | null,
  ) => Promise<Session>;
}

export function createSessionSpawner(deps: SessionSpawnerDeps): SessionSpawner {
  const registry = deps.registry;
  const fleet = deps.fleet;
  const claims = deps.claims;
  const harnesses = deps.harnesses;
  const rollback = deps.rollback;
  const authSetup = deps.auth;
  const callbacks = deps.callbacks;
  const runSteps = deps.runSteps ?? runSpawnSteps;

  const runSpawn = async (steps: SpawnSteps, spawn: Readonly<SpawnRequest>): Promise<Session> => {
    const adapter = spawn.adapter;
    const provider = spawn.provider;
    const auth = spawn.auth;
    const id = spawn.id;
    const hostKey = spawn.hostKey;
    const target = spawn.target;
    const cwd = spawn.cwd;
    const timer = spawn.timer;
    const materialize = spawn.materialize;

    // a directory the daemon picked is reserved once per attempt, so a held
    // one moves the spawn to the next attempt; a failure whose effects may
    // still stand keeps the reservation, so no workspace lands around them
    await steps.run(
      'claim',
      () => {
        if (hostKey !== id) {
          if (materialize === null) {
            claims.claimPlainDir(id, hostKey, target, cwd);
          } else if (!spawn.autoDir) {
            claims.claimWorkspace(id, hostKey, target, cwd);
          }
        } else if (materialize === null && !registry.hasHostLifecycle(target)) {
          claims.claimMachineDir(id, target, cwd);
        }
      },
      (_claimed, failure) => {
        if (!(failure instanceof EffectRemainsError)) {
          claims.releaseWorkspace(id);
        }
      },
    );

    // The host stays readying until the record is published, so nothing
    // gives its lease back or puts it to sleep before the harness starts.
    const prepared = await harnesses.withHostReadying(hostKey, () =>
      setupSpawn(
        {
          registry,
          claims,
          rollback,
          auth: authSetup,
          callbacks,
        },
        steps,
        spawn,
      ),
    );

    // A spawn whose directory the daemon picked runs in the one it claimed,
    // as the host resolves it.
    const directory = spawn.autoDir && prepared.root !== null ? prepared.root : cwd;

    // The repository is read once the workspace is in place, so a clone
    // inside another work tree is its own. A remote directory is not on
    // the daemon's machine, so it is its own root.
    const repoRoot = provider.remote ? directory : resolveRepoRoot(directory);
    const materialized = prepared.materialized;
    const readied: SpawnReadied = { attemptID: prepared.setup.attemptID, root: prepared.root };
    const plan = prepared.setup.plan;
    const withheldEnv = materialized?.withheldEnv ?? [];

    const env = {
      ...plan.env,
      ...buildSessionEnv({
        sessionID: id,
        socket: socketPath,
        ...(prepared.recordPath === null ? {} : { sessionRecord: prepared.recordPath }),
      }),
    };

    // the caller's check runs again once the host is ready, before the
    // harness starts
    await steps.run('reach', spawn.requireInReach);

    const bridged = await steps.run(
      'bridge',
      () =>
        provider.remote
          ? null
          : callbacks.startMessageBridge({
              adapter,
              session: id,
              cwd: directory,
              env,
              withheldEnv,
              options: { prompt: spawn.prompt, resume: spawn.resume, ...spawn.overrides },
            }),
      () => callbacks.stopMessageBridge(id),
    );

    await steps.run('reach', spawn.requireInReach);

    const launch = bridged ?? { bin: plan.bin, args: plan.args };
    const binding = harnesses.mintBridgeBinding(id, target, spawn.execution.identity, hostKey);
    let initialMsg = spawn.prompt;

    if (initialMsg === '') {
      initialMsg = spawn.resume === false ? 'started' : 'adopting…';
    }

    // the session lists and boots in the same turn as the harness starts,
    // since the harness's first output can arrive in the next microtask and
    // is kept only once the session has booted
    const session = steps.runNow(
      'harness',
      () => {
        const pty = provider.spawnHarness({
          session: id,
          host: hostKey,
          bin: launch.bin,
          args: launch.args,
          cwd: directory,
          env,
          withheldEnv,
          cols: spawn.cols,
          rows: spawn.rows,
          ...authSetup.buildBrokerSpec(hostKey, plan.admission),
          onRelay: (relay) => {
            callbacks.onRelay(binding, relay);
          },
        });

        const registered: Session = {
          id,
          name: pickSpawnName(spawn, directory),
          cwd: directory,
          kind: 'pty',
          pty,
          state: 'running',
          unread: false,
          lastMsg: initialMsg,
          ...(typeof spawn.resume === 'string' ? { agentSessionID: spawn.resume } : {}),
          agent: spawn.agent,
          pinned: false,
          lastAttachedAt: callbacks.getClock().now(),
          repoRoot,
          namedBy: spawn.namedBy,
          createdAt: callbacks.getClock().now(),
          parent: spawn.parent,
          ...(spawn.prompt === '' ? {} : { prompt: spawn.prompt }),
          ...(spawn.overrides.model === undefined ? {} : { model: spawn.overrides.model }),
          ...(spawn.overrides.effort === undefined ? {} : { effort: spawn.overrides.effort }),
          ...(spawn.overrides.pluginDirs === undefined
            ? {}
            : { pluginDirs: spawn.overrides.pluginDirs }),
          target,
          targetIdentity: spawn.execution.identity,
          ...(materialized === null ? {} : { workspace: materialized.workspace }),
          withheldEnv,
          desired: 'run',
          vm: 'none',
          attachment: 'local',
          suspended: false,
          hostKey,
          bridgeEpoch: binding.epoch,
          ...(plan.admission === null ? {} : { authRevision: plan.admission.revision }),
        };

        harnesses.attachHarness(registered, pty, registry.hasHostLifecycle(target));
        registry.sessions.push(registered);
        harnesses.startingSpawns.set(id, readied);

        return registered;
      },
      () => rollback.removeListedSpawn(id, readied.root),
    );

    steps.runNow('list', () => {
      claims.releaseWorkspace(id);
      void fleet.tryWriteFleet(session.id);
      fleet.writeStatus();
      callbacks.onEvent('added', session);
      callbacks.onBoot(session, spawn.cols, spawn.rows);
    });

    // a start the host refuses throws here, after the session listed, and the
    // unwind takes the session back; a shared host nothing else runs on
    // sleeps first, and a host of its own goes with the take-back
    await steps.run('harness-start', () =>
      timer.withStep('harness-start', async () => {
        if (auth !== null && hostKey === id) {
          await session.pty?.waitForStart?.();
        } else if (auth !== null && session.pty !== null) {
          await harnesses.waitForAuthStart(session, provider, session.pty);
        }
      }),
    );

    const readyAttempt = prepared.setup.attemptID;

    if (readyAttempt !== null) {
      await steps.run('auth-ready', () =>
        timer.withStep('auth-ready', () =>
          authSetup.requireAuthBinder().updateReady(hostKey, readyAttempt),
        ),
      );
    }

    const answer = spawn.answer;

    if (answer !== null) {
      await steps.run('answer', () => {
        answer(session);
      });
    }

    harnesses.startingSpawns.delete(id);

    if (provider.remote) {
      callbacks.log(
        `atc: spawn of session ${id} on target '${target}' took ${timer.formatSteps()}`,
      );
    }

    return session;
  };

  // one host serves a top-level session and every sub-session bound to the
  // same target name and identity, when that target's hosts have a lifecycle
  const pickHostKey = (
    id: SessionID,
    parent: SessionID | null,
    target: string,
    identity: string,
  ): SessionID => {
    const owner =
      parent === null ? undefined : registry.sessions.find((session) => session.id === parent);

    if (
      owner === undefined ||
      owner.target !== target ||
      owner.targetIdentity !== identity ||
      !registry.hasHostLifecycle(target)
    ) {
      return id;
    }

    return owner.hostKey;
  };

  return {
    spawn: async (
      cwd,
      name,
      prompt,
      cols,
      rows,
      resume = false,
      namedBy = 'auto',
      agent = 'claude',
      parent = null,
      overrides = {},
      id = mintSessionID(),
      target = 'local',
      materialize = null,
      requireInReach = () => {},
      autoDir = false,
      scope = null,
      answer = null,
    ) => {
      const adapter = registry.findAdapter(agent);

      if (adapter === null) {
        throw new Error(`no adapter for agent '${agent}'`);
      }

      const execution = registry.requireExecution({ target, targetIdentity: null }, 'spawn');
      const provider = execution.provider;
      const timer = createStepTimer(callbacks.now);

      const trustClonedWorkspace =
        overrides.trustClonedWorkspace ??
        registry.targets.get(target)?.options['trustClonedWorkspace'] === true;

      const hostKey = pickHostKey(id, parent, target, execution.identity);
      const auth = authSetup.resolveHarnessAuth(adapter, provider, target);

      if (trustClonedWorkspace) {
        if (materialize === null) {
          throw new DaemonError('bad_args', 'trustClonedWorkspace requires a workspace source');
        }

        const isLocalTrust =
          !provider.remote && auth === null && adapter.updateLocalWorkspaceTrust !== undefined;

        const isGuestTrust =
          provider.guestWorkspaceTrust === true &&
          provider.remote &&
          auth !== null &&
          adapter.planGuestWorkspaceTrust !== undefined;

        if (!isLocalTrust && !isGuestTrust) {
          throw new DaemonError(
            'unsupported',
            'trustClonedWorkspace requires stock Claude on the local target, or stock Claude, a Claude gateway, or Codex signed in through the broker on a remote target that can trust a clone',
          );
        }
      }

      if (hostKey !== id) {
        await authSetup.requireSharedBinding(hostKey, auth?.binding ?? null);
      }

      const refusal = adapter.findSpawnRefusal?.() ?? null;

      if (refusal !== null) {
        throw refusal;
      }

      // A spawn whose steps fail takes back what the steps before the failure
      // did, last step first; the session counts as rolling back until the
      // unwind ends, so no revive starts it in between.
      try {
        return await runSteps(id, (steps) =>
          runSpawn(steps, {
            adapter,
            provider,
            execution,
            auth,
            id,
            hostKey,
            target,
            cwd,
            name,
            prompt,
            cols,
            rows,
            resume,
            namedBy,
            agent,
            parent,
            overrides,
            materialize,
            requireInReach,
            autoDir,
            scope,
            trustClonedWorkspace,
            timer,
            answer,
          }),
        );
      } finally {
        rollback.rollingBack.delete(id);
      }
    },
  };
}
