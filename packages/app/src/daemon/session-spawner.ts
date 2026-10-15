import { posix } from 'node:path';
import { socketPath } from '@atc/config';
import type { AgentID, AgentSessionID, SessionID, StepTimer } from '@atc/core';
import { buildTarArchive, createStepTimer } from '@atc/core';
import type { AgentAdapter, ExecutionProvider, SpawnOverrides } from '@atc/plugin-api';
import { EffectRemainsError } from '@atc/plugin-api';
import type { DeclaredScope, SessionWorkspace } from '@atc/protocol';
import { buildSessionEnv } from '@atc/protocol/session';
import { DaemonError } from '@atc/protocol/wire';
import { resolveRepoRoot } from '../shared/resolve-repo-root';
import type { AuthSetup, HarnessAuthSetup, HarnessSetup } from './auth-setup';
import type { HostDirClaims } from './host-dir-claims';
import { mintSessionID } from './mint-session-id';
import { runSpawnSteps } from './run-spawn-steps';
import type { SpawnStepRunner, SpawnSteps } from './run-spawn-steps';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionFleetWriter } from './session-fleet-writer';
import type { SessionHarnesses, SpawnReadied } from './session-harnesses';
import type { SessionRegistry } from './session-registry';
import type { SpawnRollback } from './spawn-rollback';

// A session's ready workspace and the variables its harnesses go without.
interface MaterializedSpawn {
  readonly workspace: SessionWorkspace;

  // The branch the checkout is on, null for a detached checkout.
  readonly branch: string | null;
  readonly withheldEnv: readonly string[];
}

// Builds a spawn's workspace on a target bound to an identity, calling
// readyHost for the host it lands on once its source resolves and asking
// canRemoveClaim before a failure removes the directory it claimed, or
// resolves to null for a directory that runs as it stands. readyHost takes
// the attempt the directory is for: the first is the spawn's directory, and
// attempt n is that directory with `-n` appended.
export type SpawnMaterializer = (
  host: SpawnHostAccess,
  targetIdentity: string,
) => Promise<MaterializedSpawn | null>;

export interface SpawnHostAccess {
  readonly readyHost: (
    attempt: number,
  ) => Promise<{ readonly host: SessionID; readonly dir: string }>;
  readonly removeClaim: (dir: string) => Promise<boolean>;
  readonly timer: StepTimer;
}

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
    | 'shouldDestroyHost'
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
    | 'getRecords'
    | 'startMessageBridge'
    | 'stopMessageBridge'
  >;

  // Runs each spawn's steps and unwinds them on a failure; the spawn steps
  // runner when unset.
  readonly runSteps?: SpawnStepRunner;
}

// What a spawn settled on before its first step: the agent, the target and
// its host, the auth the harness takes, and the caller's request.
interface SpawnRequest {
  readonly adapter: AgentAdapter;
  readonly provider: ExecutionProvider;
  readonly execution: ReturnType<SessionRegistry['requireExecution']>;
  readonly auth: ReturnType<AuthSetup['resolveHarnessAuth']>;
  readonly id: SessionID;
  readonly hostKey: SessionID;
  readonly target: string;
  readonly cwd: string;
  readonly name: string;
  readonly prompt: string;
  readonly cols: number;
  readonly rows: number;
  readonly resume: boolean | AgentSessionID;
  readonly namedBy: 'user' | 'auto';
  readonly agent: AgentID;
  readonly parent: SessionID | null;
  readonly overrides: SpawnOverrides;
  readonly materialize: SpawnMaterializer | null;
  readonly requireInReach: () => void;
  readonly autoDir: boolean;
  readonly scope: DeclaredScope | null;
  readonly trustClonedWorkspace: boolean;
  readonly timer: StepTimer;

  // Builds the caller's answer once the harness started, as the spawn's
  // last step, so a failure there unwinds the spawn too.
  readonly answer: ((s: Session) => void) | null;
}

/**
 * Starts a new session: it checks every refusal before anything starts,
 * then runs the spawn as a list of steps, each with its undo: it claims the
 * session's directory on its host, readies the host and builds the
 * workspace there, publishes the session's record, and starts the harness.
 * A step that fails unwinds the steps before it, last step first.
 */
export class SessionSpawner {
  private readonly registry: SessionSpawnerDeps['registry'];

  private readonly fleet: SessionSpawnerDeps['fleet'];

  private readonly claims: SessionSpawnerDeps['claims'];

  private readonly harnesses: SessionSpawnerDeps['harnesses'];

  private readonly rollback: SessionSpawnerDeps['rollback'];

  private readonly auth: SessionSpawnerDeps['auth'];

  private readonly callbacks: SessionSpawnerDeps['callbacks'];

  private readonly runSteps: SpawnStepRunner;

  constructor(deps: SessionSpawnerDeps) {
    this.registry = deps.registry;
    this.fleet = deps.fleet;
    this.claims = deps.claims;
    this.harnesses = deps.harnesses;
    this.rollback = deps.rollback;
    this.auth = deps.auth;
    this.callbacks = deps.callbacks;
    this.runSteps = deps.runSteps ?? runSpawnSteps;
  }

  // resume: true opens the agent's own session picker; an agent session id
  // resumes that specific session (fleet restore). parent makes the new
  // session a sub-session of that one. overrides hold the model and effort
  // the new process runs with, and the session keeps them for every revive.
  // id is minted here unless the caller minted it ahead of the spawn. target
  // is the execution target the harness runs on; one this daemon cannot use
  // refuses the spawn before anything starts. materialize builds cwd on the
  // host once every refusal has passed and the host is ready, and returns
  // what cwd was materialized from, when it was, and the variables the
  // session's harnesses go without; a failure there takes back the host the
  // spawn readied, unless it is a parent's.
  async spawn(
    cwd: string,
    name: string,
    prompt: string,
    cols: number,
    rows: number,
    resume: boolean | AgentSessionID = false,
    namedBy: 'user' | 'auto' = 'auto',
    agent: AgentID = 'claude',
    parent: SessionID | null = null,
    overrides: SpawnOverrides = {},
    id: SessionID = mintSessionID(),
    target = 'local',
    materialize: SpawnMaterializer | null = null,
    requireInReach: () => void = () => {},
    autoDir = false,
    scope: DeclaredScope | null = null,
    answer: ((s: Session) => void) | null = null,
  ): Promise<Session> {
    const adapter = this.registry.findAdapter(agent);

    if (adapter === null) {
      throw new Error(`no adapter for agent '${agent}'`);
    }

    const execution = this.registry.requireExecution({ target, targetIdentity: null }, 'spawn');
    const provider = execution.provider;
    const timer = createStepTimer(this.callbacks.now);

    const trustClonedWorkspace =
      overrides.trustClonedWorkspace ??
      this.registry.targets.get(target)?.options['trustClonedWorkspace'] === true;

    const hostKey = this.pickHostKey(id, parent, target, execution.identity);
    const auth = this.auth.resolveHarnessAuth(adapter, provider, target);

    if (trustClonedWorkspace) {
      if (materialize === null) {
        throw new DaemonError('bad_args', 'trustClonedWorkspace requires a workspace source');
      }

      const isLocalTrust =
        !provider.remote && auth === null && adapter.updateLocalWorkspaceTrust !== undefined;

      const isGuestTrust =
        provider.kind === 'imp' &&
        provider.remote &&
        auth !== null &&
        adapter.planGuestWorkspaceTrust !== undefined;

      if (!isLocalTrust && !isGuestTrust) {
        throw new DaemonError(
          'unsupported',
          'trustClonedWorkspace requires stock Claude on the local target, or stock Claude, a Claude gateway, or Codex signed in through the broker on an imp target',
        );
      }
    }

    if (hostKey !== id) {
      await this.auth.requireSharedBinding(hostKey, auth?.binding ?? null);
    }

    const refusal = adapter.findSpawnRefusal?.() ?? null;

    if (refusal !== null) {
      throw refusal;
    }

    // A spawn whose steps fail takes back what the steps before the failure
    // did, last step first; the session counts as rolling back until the
    // unwind ends, so no revive starts it in between.
    try {
      return await this.runSteps(id, (steps) =>
        this.runSpawn(steps, {
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
      this.rollback.rollingBack.delete(id);
    }
  }

  // The spawn's steps, in order: claim the directory, ready the host, build
  // the workspace and check and trust it, publish the record, start the
  // message bridge, start the harness and list the session, wait for the
  // harness to start, and build the caller's answer. Each step that leaves
  // something behind gives its undo.
  private async runSpawn(steps: SpawnSteps, spawn: Readonly<SpawnRequest>): Promise<Session> {
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

    // A directory the daemon picked is checked and reserved on the host
    // once per attempt, so a held one moves the spawn to the next attempt
    // instead of refusing it. A failure whose effects may still stand keeps
    // the reservation, so no other workspace lands in or around them.
    await steps.run(
      'claim',
      () => {
        if (hostKey !== id) {
          if (materialize === null) {
            this.claims.claimPlainDir(id, hostKey, target, cwd);
          } else if (!spawn.autoDir) {
            this.claims.claimWorkspace(id, hostKey, target, cwd);
          }
        } else if (materialize === null && !this.registry.hasHostLifecycle(target)) {
          this.claims.claimMachineDir(id, target, cwd);
        }
      },
      (_claimed, failure) => {
        if (!(failure instanceof EffectRemainsError)) {
          this.claims.releaseWorkspace(id);
        }
      },
    );

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
          const setup = await this.auth.setupHarnessOnHost(
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
          if (this.rollback.shouldTakeHost(provider, id, hostKey, target, setup.attemptID)) {
            await this.rollback.destroyFailedSpawnHost(provider, id, hostKey, setup.attemptID);
          }
        },
      );

      return hostSetup;
    };

    // Takes back trust a spawn accepted in the user's own agent config.
    let removeTrust: (() => Promise<void>) | null = null;

    // The host stays readying until the record is published, so nothing
    // gives its lease back or puts it to sleep before the harness starts.
    const prepared = await this.harnesses.withHostReadying(hostKey, async () => {
      const built =
        materialize === null
          ? { materialized: null, root: null }
          : await this.buildSpawnWorkspace(steps, spawn, materialize, setupHost, () => attemptID);

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
            this.auth.requireProjectSettings(adapter, provider, hostKey, target, root),
          ),
        );
      }

      if (root !== null && spawn.trustClonedWorkspace) {
        await steps.run(
          'trust',
          async () => {
            removeTrust = await this.applyWorkspaceTrust(spawn, root);
          },
          () => this.rollback.removeLocalTrust(removeTrust, id),
        );
      }

      const records = this.callbacks.getRecords();
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
          await this.callbacks.getRecords()?.remove(id);
        },
      );

      return { setup, materialized: built.materialized, root, recordPath };
    });

    // A spawn whose directory the daemon picked runs in the one it claimed,
    // as the host resolves it.
    const dir = spawn.autoDir && prepared.root !== null ? prepared.root : cwd;

    // The repository is read once the workspace is in place, so a clone
    // inside another work tree is its own. A remote directory is not on
    // the daemon's machine, so it is its own root.
    const repoRoot = provider.remote ? dir : resolveRepoRoot(dir);
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

    // The caller's check runs again once the host is ready, before the
    // harness starts. A local agent that takes its messages through a bridge
    // in the daemon starts the bridge first, and its terminal starts
    // against it.
    await steps.run('reach', spawn.requireInReach);

    const bridged = await steps.run(
      'bridge',
      () =>
        provider.remote
          ? null
          : this.callbacks.startMessageBridge({
              adapter,
              session: id,
              cwd: dir,
              env,
              withheldEnv,
              options: { prompt: spawn.prompt, resume: spawn.resume, ...spawn.overrides },
            }),
      () => this.callbacks.stopMessageBridge(id),
    );

    await steps.run('reach', spawn.requireInReach);

    const launch = bridged ?? { bin: plan.bin, args: plan.args };
    const binding = this.harnesses.mintBridgeBinding(id, target, spawn.execution.identity, hostKey);
    let initialMsg = spawn.prompt;

    if (initialMsg === '') {
      initialMsg = spawn.resume === false ? 'started' : 'adopting…';
    }

    // The session lists and boots in the same turn its harness starts, since
    // the harness's first output can arrive in the next microtask and is
    // kept only once the session has booted. The undo kills the harness and
    // takes the session out of the list and the fleet; a listing that
    // throws takes that back before the step throws.
    const session = await steps.run(
      'harness',
      async () => {
        const pty = provider.spawnHarness({
          session: id,
          host: hostKey,
          bin: launch.bin,
          args: launch.args,
          cwd: dir,
          env,
          withheldEnv,
          cols: spawn.cols,
          rows: spawn.rows,
          ...this.auth.buildBrokerSpec(hostKey, plan.admission),
          onRelay: (relay) => {
            this.callbacks.onRelay(binding, relay);
          },
        });

        const registered: Session = {
          id,
          name: spawn.namedBy === 'auto' && dir !== cwd ? posix.basename(dir) : spawn.name,
          cwd: dir,
          kind: 'pty',
          pty,
          state: 'running',
          unread: false,
          lastMsg: initialMsg,
          ...(typeof spawn.resume === 'string' ? { agentSessionID: spawn.resume } : {}),
          agent: spawn.agent,
          pinned: false,
          lastAttachedAt: this.callbacks.getClock().now(),
          repoRoot,
          namedBy: spawn.namedBy,
          createdAt: this.callbacks.getClock().now(),
          parent: spawn.parent,
          ...(spawn.prompt === '' ? {} : { prompt: spawn.prompt }),
          ...(spawn.overrides.model === undefined ? {} : { model: spawn.overrides.model }),
          ...(spawn.overrides.effort === undefined ? {} : { effort: spawn.overrides.effort }),
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

        this.harnesses.attachHarness(registered, pty, this.registry.hasHostLifecycle(target));
        this.registry.sessions.push(registered);
        this.harnesses.startingSpawns.set(id, readied);

        try {
          this.claims.releaseWorkspace(id);
          void this.fleet.tryWriteFleet(id);
          this.fleet.writeStatus();
          this.callbacks.onEvent('added', registered);
          this.callbacks.onBoot(registered, spawn.cols, spawn.rows);
        } catch (error) {
          await this.rollback.removeListedSpawn(id, readied.root).catch((cleanupError: unknown) => {
            throw new EffectRemainsError(
              `spawn of session ${id} failed and taking back its harness step failed too`,
              { cause: cleanupError },
            );
          });

          throw error;
        }

        return registered;
      },
      () => this.rollback.removeListedSpawn(id, readied.root),
    );

    // A start impd refuses throws here, after the session listed, and the
    // unwind takes the session back with its binding. A shared host that
    // nothing else runs on goes back to sleep first; a host of its own goes
    // with the take-back.
    await steps.run('harness-start', () =>
      timer.withStep('harness-start', async () => {
        if (auth !== null && hostKey === id) {
          await session.pty?.waitForStart?.();
        } else if (auth !== null && session.pty !== null) {
          await this.harnesses.waitForAuthStart(session, provider, session.pty);
        }
      }),
    );

    const readyAttempt = prepared.setup.attemptID;

    if (readyAttempt !== null) {
      await steps.run('auth-ready', () =>
        timer.withStep('auth-ready', () =>
          this.auth.requireAuthBinder().updateReady(hostKey, readyAttempt),
        ),
      );
    }

    const answer = spawn.answer;

    if (answer !== null) {
      await steps.run('answer', () => {
        answer(session);
      });
    }

    this.harnesses.startingSpawns.delete(id);

    if (provider.remote) {
      this.callbacks.log(
        `atc: spawn of session ${id} on target '${target}' took ${timer.formatSteps()}`,
      );
    }

    return session;
  }

  // Builds the spawn's workspace, setting its host up once the source
  // resolves, and returns the directory it created, null for one that runs
  // as it stands. The workspace's undo removes that directory, unless the
  // host's own undo destroys the host with it.
  private async buildSpawnWorkspace(
    steps: SpawnSteps,
    spawn: Readonly<SpawnRequest>,
    materialize: SpawnMaterializer,
    setupHost: () => Promise<unknown>,
    findAttemptID: () => string | null,
  ): Promise<{ readonly materialized: MaterializedSpawn | null; readonly root: string | null }> {
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
                    this.claims.resolveHostHome(provider, hostKey),
                  );

              const base = posix.isAbsolute(dir) ? dir : posix.join(hostHome, dir);
              const candidate = attempt === 1 ? base : `${base}-${attempt}`;

              const landing = await timer.withStep('dir-claim', () =>
                this.registry.hasHostLifecycle(target)
                  ? this.claims.claimHostDir(
                      provider,
                      id,
                      hostKey,
                      target,
                      candidate,
                      spawn.autoDir && hostKey !== id,
                    )
                  : this.claims.resolveHostDir(provider, null, candidate),
              );

              landed = landing;

              return { host: hostKey, dir: landing };
            },
            removeClaim: (landing) =>
              this.claims.removeClaimedDir(provider, id, hostKey, target, landing),
            timer,
          },
          spawn.execution.identity,
        ),
      async (built) => {
        const root = landed;

        const destroysHost =
          findAttemptID() === null &&
          this.rollback.shouldDestroyHost(provider, id, hostKey, target);

        if (built === null || root === null || destroysHost) {
          return;
        }

        await this.rollback.removeSpawnWorkspace(provider, id, hostKey, target, root);
      },
    );

    return { materialized, root: materialized === null ? null : landed };
  }

  // Trusts a cloned workspace: in the user's own agent config on the local
  // target, returning how to take the trust back, or in the session's guest
  // folder on an imp, which takes nothing back.
  private async applyWorkspaceTrust(
    spawn: Readonly<SpawnRequest>,
    root: string,
  ): Promise<(() => Promise<void>) | null> {
    const adapter = spawn.adapter;
    const provider = spawn.provider;

    if (!provider.remote) {
      const update = adapter.updateLocalWorkspaceTrust;

      if (update === undefined) {
        throw new DaemonError('unsupported', 'this adapter cannot trust a cloned workspace');
      }

      return update.call(adapter, root);
    }

    const planned = adapter.planGuestWorkspaceTrust?.(root);

    if (planned === undefined || planned === null || provider.guest === undefined) {
      throw new DaemonError('unsupported', 'this adapter cannot trust a cloned workspace');
    }

    const files = Object.entries(planned).map(([path, content]) => ({ path, content }));
    const dir = `${provider.guest.dir}/sessions/${spawn.id}`;

    await spawn.timer.withStep('trust-transfer', () =>
      provider.transferArchive(buildTarArchive(files), dir, spawn.hostKey),
    );

    return null;
  }

  // A sub-session runs on its parent's host when its resolved target, name
  // and identity both, is the one its parent is bound to and that target's
  // hosts have a lifecycle, so one host serves a top-level session and
  // every sub-session beside it there; any other session has a host of its
  // own.
  private pickHostKey(
    id: SessionID,
    parent: SessionID | null,
    target: string,
    identity: string,
  ): SessionID {
    const owner = parent === null ? undefined : this.registry.sessions.find((s) => s.id === parent);

    if (
      owner === undefined ||
      owner.target !== target ||
      owner.targetIdentity !== identity ||
      !this.registry.hasHostLifecycle(target)
    ) {
      return id;
    }

    return owner.hostKey;
  }
}
