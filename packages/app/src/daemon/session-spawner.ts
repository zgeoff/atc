import { posix } from 'node:path';
import { socketPath } from '@atc/config';
import type { AgentID, AgentSessionID, SessionID, StepTimer } from '@atc/core';
import { buildTarArchive, createStepTimer } from '@atc/core';
import type { ExecutionProvider, HarnessHandle, SpawnOverrides } from '@atc/plugin-api';
import { EffectRemainsError } from '@atc/plugin-api';
import type { DeclaredScope, SessionWorkspace } from '@atc/protocol';
import { buildSessionEnv } from '@atc/protocol/session';
import { DaemonError } from '@atc/protocol/wire';
import { resolveRepoRoot } from '../shared/resolve-repo-root';
import type { AuthSetup, HarnessAuthSetup, HarnessSetup } from './auth-setup';
import type { HostDirClaims } from './host-dir-claims';
import { mintSessionID } from './mint-session-id';
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
    'destroyFailedSpawnHost' | 'removeFailedSpawnEffects' | 'removeLocalTrust'
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
    'onBoot' | 'onEvent' | 'onRelay' | 'log' | 'now' | 'getClock' | 'getRecords'
  >;
}

/**
 * Starts a new session: it checks every refusal before anything starts,
 * claims the session's directory on its host, readies the host and
 * builds the workspace there, publishes the session's record, and starts
 * the harness, taking back what it readied when a step fails.
 */
export class SessionSpawner {
  private readonly registry: SessionSpawnerDeps['registry'];

  private readonly fleet: SessionSpawnerDeps['fleet'];

  private readonly claims: SessionSpawnerDeps['claims'];

  private readonly harnesses: SessionSpawnerDeps['harnesses'];

  private readonly rollback: SessionSpawnerDeps['rollback'];

  private readonly auth: SessionSpawnerDeps['auth'];

  private readonly callbacks: SessionSpawnerDeps['callbacks'];

  // oxlint-disable-next-line prefer-readonly-parameter-types -- the modules it holds keep mutable session state
  constructor(deps: SessionSpawnerDeps) {
    this.registry = deps.registry;
    this.fleet = deps.fleet;
    this.claims = deps.claims;
    this.harnesses = deps.harnesses;
    this.rollback = deps.rollback;
    this.auth = deps.auth;
    this.callbacks = deps.callbacks;
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

    const authSetup: HarnessAuthSetup | null =
      auth === null
        ? null
        : {
            ...auth,
            mode: hostKey === id ? 'create' : 'verify',
            targetIdentity: execution.identity,
          };

    const refusal = adapter.findSpawnRefusal?.() ?? null;

    if (refusal !== null) {
      throw refusal;
    }

    // A directory the daemon picked is checked and reserved on the host
    // once per attempt, so a held one moves the spawn to the next attempt
    // instead of refusing it.
    if (hostKey !== id) {
      if (materialize === null) {
        this.claims.claimPlainDir(id, hostKey, target, cwd);
      } else if (!autoDir) {
        this.claims.claimWorkspace(id, hostKey, target, cwd);
      }
    } else if (materialize === null && !this.registry.hasHostLifecycle(target)) {
      this.claims.claimMachineDir(id, target, cwd);
    }

    // A spawn that builds its workspace reads the workspace's project
    // settings once it is built, not when the host is readied before it.
    const startDir = materialize === null ? cwd : null;

    const setupHost = () =>
      this.auth.setupHarnessOnHost(
        adapter,
        provider,
        id,
        hostKey,
        target,
        { prompt, resume, ...overrides },
        authSetup,
        startDir,
        hostKey === id,
        timer,
      );

    // A launch behind the broker reads the project settings of the clone it
    // starts in, once the clone is on the host and before it is trusted.
    const checkWorkspace =
      auth === null
        ? null
        : (root: string) =>
            timer.withStep('project-settings', () =>
              this.auth.requireProjectSettings(adapter, provider, hostKey, target, root),
            );

    // Takes back trust a spawn accepted in the user's own agent config when
    // the spawn fails before its harness starts.
    const localTrust: { remove: (() => Promise<void>) | null } = { remove: null };

    const trustWorkspace = trustClonedWorkspace
      ? async (root: string) => {
          if (!provider.remote) {
            const update = adapter.updateLocalWorkspaceTrust;

            if (update === undefined) {
              throw new DaemonError('unsupported', 'this adapter cannot trust a cloned workspace');
            }

            localTrust.remove = await update.call(adapter, root);

            return;
          }

          const planned = adapter.planGuestWorkspaceTrust?.(root);

          if (planned === undefined || planned === null || provider.guest === undefined) {
            throw new DaemonError('unsupported', 'this adapter cannot trust a cloned workspace');
          }

          const files = Object.entries(planned).map(([path, content]) => ({ path, content }));
          const dir = `${provider.guest.dir}/sessions/${id}`;

          await timer.withStep('trust-transfer', () =>
            provider.transferArchive(buildTarArchive(files), dir, hostKey),
          );
        }
      : null;

    // The host stays readying until its workspace is in place, so nothing
    // gives its lease back or puts it to sleep in between.
    // The record is published while the host still counts as readying, so
    // nothing sleeps it between the record and the harness start.
    const published: { path: string | null; failure: { readonly error: unknown } | null } = {
      path: null,
      failure: null,
    };

    const prepared = await this.harnesses.withHostReadying(hostKey, async () => {
      const ready =
        materialize === null
          ? { setup: await setupHost(), materialized: null, root: null }
          : await this.materializeOnSpawnHost(
              provider,
              id,
              hostKey,
              target,
              cwd,
              autoDir,
              execution.identity,
              materialize,
              setupHost,
              checkWorkspace,
              trustWorkspace,
              timer,
            );

      const records = this.callbacks.getRecords();

      try {
        published.path =
          records === null
            ? null
            : await timer.withStep('record', () =>
                records.createRecord(
                  {
                    session: id,
                    target,
                    provider,
                    host: hostKey,
                    dir: autoDir && ready.root !== null ? ready.root : cwd,
                    workspace: ready.materialized?.workspace ?? null,
                    ...(ready.materialized === null ? {} : { branch: ready.materialized.branch }),
                  },
                  scope,
                ),
              );
      } catch (error) {
        published.failure = { error };
      }

      return ready;
    });

    // A spawn whose directory the daemon picked runs in the one it claimed,
    // as the host resolves it.
    const dir = autoDir && prepared.root !== null ? prepared.root : cwd;

    // The repository is read once the workspace is in place, so a clone
    // inside another work tree is its own. A remote directory is not on
    // the daemon's machine, so it is its own root.
    const repoRoot = provider.remote ? dir : resolveRepoRoot(dir);
    const setup = prepared.setup;
    const materialized = prepared.materialized;
    const readied: SpawnReadied = { attemptID: setup.attemptID, root: prepared.root };

    // A scope that fails its check, or a record that cannot be placed,
    // takes back what the spawn readied before any harness starts.
    if (published.failure !== null) {
      await this.rollback.removeLocalTrust(localTrust.remove, id);
      await this.callbacks.getRecords()?.remove(id);
      await this.rollback.removeFailedSpawnEffects(provider, id, hostKey, target, readied);

      throw published.failure.error;
    }

    const plan = setup.plan;
    const binding = this.harnesses.mintBridgeBinding(id, target, execution.identity, hostKey);
    let pty: HarnessHandle;

    // The caller's check runs again once the host is ready, before the
    // harness starts. A refusal there, or a harness its provider cannot
    // start, takes back what the spawn readied.
    try {
      requireInReach();

      pty = provider.spawnHarness({
        session: id,
        host: hostKey,
        bin: plan.bin,
        args: plan.args,
        cwd: dir,
        env: {
          ...plan.env,
          ...buildSessionEnv({
            sessionID: id,
            socket: socketPath,
            ...(published.path === null ? {} : { sessionRecord: published.path }),
          }),
        },
        withheldEnv: materialized?.withheldEnv ?? [],
        cols,
        rows,
        ...this.auth.buildBrokerSpec(hostKey, plan.admission),
        onRelay: (relay) => {
          this.callbacks.onRelay(binding, relay);
        },
      });
    } catch (error) {
      await this.rollback.removeLocalTrust(localTrust.remove, id);
      await this.callbacks.getRecords()?.remove(id);
      await this.rollback.removeFailedSpawnEffects(provider, id, hostKey, target, readied);

      throw error;
    }

    let initialMsg = prompt;

    if (initialMsg === '') {
      initialMsg = resume === false ? 'started' : 'adopting…';
    }

    const session: Session = {
      id,
      name: namedBy === 'auto' && dir !== cwd ? posix.basename(dir) : name,
      cwd: dir,
      kind: 'pty',
      pty,
      state: 'running',
      unread: false,
      lastMsg: initialMsg,
      ...(typeof resume === 'string' ? { agentSessionID: resume } : {}),
      agent,
      pinned: false,
      lastAttachedAt: this.callbacks.getClock().now(),
      repoRoot,
      namedBy,
      createdAt: this.callbacks.getClock().now(),
      parent,
      ...(prompt === '' ? {} : { prompt }),
      ...(overrides.model === undefined ? {} : { model: overrides.model }),
      ...(overrides.effort === undefined ? {} : { effort: overrides.effort }),
      target,
      targetIdentity: execution.identity,
      ...(materialized === null ? {} : { workspace: materialized.workspace }),
      withheldEnv: materialized?.withheldEnv ?? [],
      desired: 'run',
      vm: 'none',
      attachment: 'local',
      suspended: false,
      hostKey,
      bridgeEpoch: binding.epoch,
      ...(plan.admission === null ? {} : { authRevision: plan.admission.revision }),
    };

    this.harnesses.attachHarness(session, pty, this.registry.hasHostLifecycle(target));
    this.registry.sessions.push(session);
    this.harnesses.startingSpawns.set(id, readied);
    this.claims.releaseWorkspace(id);
    void this.fleet.tryWriteFleet(session.id);
    this.fleet.writeStatus();
    this.callbacks.onEvent('added', session);
    this.callbacks.onBoot(session, cols, rows);

    // A start impd refuses throws here, after the session listed, so the
    // caller takes the failed spawn back with its binding. A shared host
    // that nothing else runs on goes back to sleep first; a host of its
    // own goes with the take-back.
    await timer.withStep('harness-start', async () => {
      if (auth !== null && hostKey === id) {
        await pty.waitForStart?.();
      } else if (auth !== null) {
        await this.harnesses.waitForAuthStart(session, provider, pty);
      }
    });

    if (setup.attemptID !== null) {
      const attemptID = setup.attemptID;

      await timer.withStep('auth-ready', () =>
        this.auth.requireAuthBinder().updateReady(hostKey, attemptID),
      );
    }

    this.harnesses.startingSpawns.delete(id);

    if (provider.remote) {
      this.callbacks.log(
        `atc: spawn of session ${id} on target '${target}' took ${timer.formatSteps()}`,
      );
    }

    return session;
  }

  // Materializes a spawn's workspace, readying its host once the source
  // resolves, or after the workspace for a directory that runs as it
  // stands, and returns the directory it created, null for one that runs
  // as it stands. A clone is checked and then trusted, either as the caller
  // asks, and a failure there removes it. A failure once the host is ready
  // takes it back.
  private async materializeOnSpawnHost(
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
    dir: string,
    autoDir: boolean,
    targetIdentity: string,
    materialize: SpawnMaterializer,
    setupHost: () => Promise<HarnessSetup>,
    checkWorkspace: ((root: string) => Promise<void>) | null,
    trustWorkspace: ((root: string) => Promise<void>) | null,
    timer: StepTimer,
  ): Promise<{
    readonly setup: HarnessSetup;
    readonly materialized: MaterializedSpawn | null;
    readonly root: string | null;
  }> {
    const readied: { setup: HarnessSetup | null; root: string | null } = {
      setup: null,
      root: null,
    };

    const hostHome: { dir: string | null } = { dir: null };

    try {
      const materialized = await materialize(
        {
          readyHost: async (attempt) => {
            readied.setup ??= await setupHost();

            // A directory the daemon picked on a remote target is relative
            // to the home there, which only the readied host can resolve.
            hostHome.dir ??= posix.isAbsolute(dir)
              ? ''
              : await timer.withStep('host-home', () =>
                  this.claims.resolveHostHome(provider, hostKey),
                );

            const base = posix.isAbsolute(dir) ? dir : posix.join(hostHome.dir, dir);
            const candidate = attempt === 1 ? base : `${base}-${attempt}`;

            const landing = await timer.withStep('dir-claim', () =>
              this.registry.hasHostLifecycle(target)
                ? this.claims.claimHostDir(
                    provider,
                    id,
                    hostKey,
                    target,
                    candidate,
                    autoDir && hostKey !== id,
                  )
                : this.claims.resolveHostDir(provider, null, candidate),
            );

            readied.root = landing;

            return { host: hostKey, dir: landing };
          },
          removeClaim: (landing) =>
            this.claims.removeClaimedDir(provider, id, hostKey, target, landing),
          timer,
        },
        targetIdentity,
      );

      readied.setup ??= await setupHost();

      if (trustWorkspace !== null && (materialized === null || readied.root === null)) {
        throw new DaemonError(
          'bad_args',
          'trustClonedWorkspace requires a successfully cloned workspace',
        );
      }

      if (materialized !== null && readied.root !== null) {
        try {
          await checkWorkspace?.(readied.root);
          await trustWorkspace?.(readied.root);
        } catch (error) {
          let removed = false;

          try {
            removed = await this.claims.removeClaimedDir(
              provider,
              id,
              hostKey,
              target,
              readied.root,
            );
          } catch {
            // A failed rollback retains the spawn's claim for reconciliation.
          }

          if (!removed) {
            throw new EffectRemainsError(
              'workspace setup failed and its clone could not be removed',
              { cause: error },
            );
          }

          throw error;
        }
      }

      return {
        setup: readied.setup,
        materialized,
        root: materialized === null ? null : readied.root,
      };
    } catch (error) {
      if (readied.setup !== null) {
        await this.rollback.destroyFailedSpawnHost(provider, id, hostKey, readied.setup.attemptID);
      }

      throw error;
    }
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
