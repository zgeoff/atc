import { socketPath } from '@atc/config';
import { createStepTimer } from '@atc/core';
import type { SessionID } from '@atc/core';
import type { ExecutionProvider, HarnessHandle } from '@atc/plugin-api';
import { buildSessionEnv } from '@atc/protocol/session';
import { DaemonError } from '@atc/protocol/wire';
import type { AuthSetup, HarnessAuthSetup, HarnessPlan } from '../auth/auth-setup';
import type { SessionFleetWriter } from '../fleet/session-fleet-writer';
import { resolveRepoRoot } from './resolve-repo-root';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionHarnesses } from './session-harnesses';
import type { SessionRegistry } from './session-registry';
import type { SpawnRollback } from './spawn-rollback';

interface SessionAdopterDeps {
  readonly registry: Pick<
    SessionRegistry,
    'sessions' | 'unrestored' | 'findAdapter' | 'requireExecution' | 'hasHostLifecycle'
  >;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange' | 'tryWriteFleet'>;
  readonly harnesses: Pick<
    SessionHarnesses,
    | 'attachHarness'
    | 'mintBridgeBinding'
    | 'updateLaunchRevision'
    | 'waitForAuthStart'
    | 'withHostReadying'
  >;
  readonly rollback: Pick<
    SpawnRollback,
    'rollingBack' | 'unconfirmedKills' | 'isRollbackSettled' | 'killHarness'
  >;
  readonly auth: Pick<AuthSetup, 'buildBrokerSpec' | 'resolveHarnessAuth' | 'setupHarnessOnHost'>;
  readonly callbacks: Pick<
    SessionCallbacks,
    | 'onBoot'
    | 'onEvent'
    | 'onRelay'
    | 'log'
    | 'now'
    | 'getRecords'
    | 'startMessageBridge'
    | 'stopMessageBridge'
  >;
}

// What a revive starts its harness with on the session's host.
interface HarnessLaunch {
  readonly provider: ExecutionProvider;
  readonly plan: Omit<HarnessPlan, 'args'> & { readonly args: readonly string[] };
  readonly recordPath: string | null;
  readonly cols: number;
  readonly rows: number;
}

// A restart whose outdated harness waits on its kill.
interface HarnessRestart {
  readonly session: Session;
  stopped: boolean;
  readonly settled: Promise<void>;
}

export class SessionAdopter {
  // Sessions whose revive waits on their host waking, so a second revive
  // of the same session does not start a second harness.
  private readonly adopting = new Set<SessionID>();

  // Sessions whose outdated harness waits on its kill before the restart
  // starts a fresh one, each with whether a stop landed meanwhile and a
  // promise that settles once the restart leaves the session as it ends.
  private readonly restarts = new Map<SessionID, HarnessRestart>();

  private readonly registry: SessionAdopterDeps['registry'];

  private readonly fleet: SessionAdopterDeps['fleet'];

  private readonly harnesses: SessionAdopterDeps['harnesses'];

  private readonly rollback: SessionAdopterDeps['rollback'];

  private readonly auth: SessionAdopterDeps['auth'];

  private readonly callbacks: SessionAdopterDeps['callbacks'];

  constructor(deps: SessionAdopterDeps) {
    this.registry = deps.registry;
    this.fleet = deps.fleet;
    this.harnesses = deps.harnesses;
    this.rollback = deps.rollback;
    this.auth = deps.auth;
    this.callbacks = deps.callbacks;
  }

  // resolves once the waiting restart leaves the session stopped and written
  // to the fleet; false, touching nothing, when no restart waits
  async stopRestart(id: SessionID): Promise<boolean> {
    const restart = this.restarts.get(id);

    if (restart === undefined) {
      return false;
    }

    if (!restart.stopped) {
      restart.stopped = true;
      restart.session.lastMsg = 'stopping';

      this.callbacks.onEvent('state', restart.session);
    }

    await restart.settled;

    return true;
  }

  // A sibling's revive failing leaves that sibling asleep; the session
  // whose revive woke the host is already running, so the failure is
  // logged rather than thrown.
  private async tryAdoptSibling(
    sibling: Session,
    s: Session,
    cols: number,
    rows: number,
  ): Promise<void> {
    try {
      await this.adoptTerminal(sibling.id, cols, rows);
    } catch (error) {
      this.callbacks.log(
        `atc could not revive session ${sibling.id} beside ${s.id} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  // a remote host wakes first, attaching a harness it still runs and
  // reviving every session asleep beside it; the caller's check runs again
  // after each await, and a failed check leaves the session as it was
  async adoptTerminal(
    id: SessionID,
    cols: number,
    rows: number,
    canProceed: () => boolean = () => true,
  ): Promise<Session | null> {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (!s || s.pty !== null || s.agentSessionID === undefined || this.adopting.has(id)) {
      return null;
    }

    // Only a harness that sleeps inside its host restarts when it launched
    // under an older revision: one that runs, such as a harness a restore
    // finds after a daemon restart, may be inside a turn a restart ends.
    const wasAsleep = s.suspended;

    const settled = await this.rollback.isRollbackSettled(id);

    if (!settled || !canProceed()) {
      return null;
    }

    const adapter = this.registry.findAdapter(s.agent);

    if (adapter === null) {
      return null;
    }

    const provider = this.registry.requireExecution(s, 'spawn').provider;
    const auth = this.auth.resolveHarnessAuth(adapter, provider, s.target);
    const timer = createStepTimer(this.callbacks.now);

    const authSetup: HarnessAuthSetup | null =
      auth === null ? null : { ...auth, mode: 'verify', targetIdentity: s.targetIdentity };

    this.adopting.add(id);

    let plan: HarnessPlan;
    let recordPath: string | null;
    const resume = s.agentSessionID;

    // The record is placed again while the host still counts as readying,
    // so a host that lost its copy, such as one that booted cold, has it
    // back before the harness starts.
    try {
      const setup = await this.harnesses.withHostReadying(s.hostKey, async () => {
        const planned = await this.auth.setupHarnessOnHost(
          adapter,
          provider,
          s.id,
          s.hostKey,
          s.target,
          {
            prompt: '',
            resume,
            ...(s.model === undefined ? {} : { model: s.model }),
            ...(s.effort === undefined ? {} : { effort: s.effort }),
          },
          authSetup,
          s.cwd,
          false,
          timer,
        );

        const records = this.callbacks.getRecords();

        const path =
          records === null
            ? null
            : await timer.withStep('record', () =>
                records.restoreCopy({
                  session: s.id,
                  target: s.target,
                  provider,
                  host: s.hostKey,
                  dir: s.cwd,
                  workspace: s.workspace ?? null,
                }),
              );

        return { plan: planned.plan, recordPath: path };
      });

      plan = setup.plan;
      recordPath = setup.recordPath;
    } catch (error) {
      this.adopting.delete(id);
      throw error;
    }

    let launch: HarnessLaunch;
    let pty: HarnessHandle;

    // The revive keeps the session taken until its terminal starts, so a
    // second revive that lands while the message bridge starts finds it
    // taken and starts nothing.
    try {
      // A kill, a second adopt, a failed spawn's rollback, or a change that
      // takes the session out of the caller's reach can land while the host
      // wakes.
      if (
        !canProceed() ||
        s.pty !== null ||
        !this.registry.sessions.includes(s) ||
        this.rollback.rollingBack.has(id) ||
        this.rollback.unconfirmedKills.has(id)
      ) {
        return null;
      }

      // the bridge starts first, on the thread the session resumes, so the
      // terminal starts against it; a change that lands while it starts
      // stops it again
      if (!provider.remote) {
        const bridged = await this.callbacks.startMessageBridge({
          adapter,
          session: s.id,
          cwd: s.cwd,
          env: {
            ...plan.env,
            ...buildSessionEnv({
              sessionID: s.id,
              socket: socketPath,
              ...(recordPath === null ? {} : { sessionRecord: recordPath }),
            }),
          },
          withheldEnv: s.withheldEnv,
          options: {
            prompt: '',
            resume,
            ...(s.model === undefined ? {} : { model: s.model }),
            ...(s.effort === undefined ? {} : { effort: s.effort }),
          },
        });

        if (
          !canProceed() ||
          s.pty !== null ||
          !this.registry.sessions.includes(s) ||
          this.rollback.rollingBack.has(id) ||
          this.rollback.unconfirmedKills.has(id)
        ) {
          await this.callbacks.stopMessageBridge(s.id);

          return null;
        }

        plan = bridged === null ? plan : { ...plan, bin: bridged.bin, args: bridged.args };
      }

      launch = { provider, plan, recordPath, cols, rows };

      // A terminal that fails to start leaves no message bridge running
      // without it.
      try {
        pty = this.startHarness(s, launch);
      } catch (error) {
        await this.callbacks.stopMessageBridge(s.id);

        throw error;
      }
    } finally {
      this.adopting.delete(id);
    }

    let start = await timer.withStep('harness-start', () =>
      auth === null
        ? Promise.resolve(undefined)
        : this.harnesses.waitForAuthStart(s, provider, pty),
    );

    const outdated =
      plan.admission !== null &&
      start?.created === false &&
      wasAsleep &&
      isLaunchOutdated(s, plan.admission.revision, plan.heldRevision);

    const restartable = outdated ? await this.isHarnessRestartable(s, pty) : false;

    if (restartable) {
      pty = await this.restartOutdatedHarness(s, pty, launch, canProceed);

      start = await timer.withStep('harness-restart', () =>
        this.harnesses.waitForAuthStart(s, provider, pty),
      );
    }

    if (plan.admission !== null) {
      this.harnesses.updateLaunchRevision(
        s,
        plan.admission.revision,
        plan.heldRevision,
        start?.created ?? true,
      );
    }

    if (provider.remote) {
      this.callbacks.log(
        `atc: wake of session ${s.id} on target '${s.target}' took ${timer.formatSteps()}`,
      );
    }

    for (const asleep of this.registry.sessions) {
      if (asleep.hostKey === s.hostKey && asleep.target === s.target && asleep.suspended) {
        await this.tryAdoptSibling(asleep, s, cols, rows);
      }
    }

    return s;
  }

  // Starts the harness that revives a session, or attaches the one its
  // host still runs, and follows it as the session's terminal.
  private startHarness(s: Session, launch: HarnessLaunch): HarnessHandle {
    const plan = launch.plan;
    const provider = launch.provider;
    const binding = this.harnesses.mintBridgeBinding(s.id, s.target, s.targetIdentity, s.hostKey);

    const pty = provider.spawnHarness({
      session: s.id,
      host: s.hostKey,
      bin: plan.bin,
      args: plan.args,
      cwd: s.cwd,
      env: {
        ...plan.env,
        ...buildSessionEnv({
          sessionID: s.id,
          socket: socketPath,
          ...(launch.recordPath === null ? {} : { sessionRecord: launch.recordPath }),
        }),
      },
      withheldEnv: s.withheldEnv,
      cols: launch.cols,
      rows: launch.rows,
      ...this.auth.buildBrokerSpec(s.hostKey, plan.admission),
      onRelay: (relay) => {
        this.callbacks.onRelay(binding, relay);
      },
    });

    s.bridgeEpoch = binding.epoch;
    s.pty = pty;
    s.kind = 'pty';
    s.state = 'running';
    s.lastMsg = 'revived';

    this.registry.unrestored.delete(s.id);

    if (plan.admission === null) {
      delete s.authRevision;
    }

    s.repoRoot = provider.remote ? s.cwd : resolveRepoRoot(s.cwd);
    s.desired = 'run';
    s.suspended = false;

    this.harnesses.attachHarness(s, pty, this.registry.hasHostLifecycle(s.target));
    this.callbacks.onBoot(s, launch.cols, launch.rows);
    void this.fleet.tryWriteFleet(s.id);
    this.callbacks.onEvent('state', s);
    this.fleet.emitChange();

    return pty;
  }

  // the harness is still the session's terminal, or ended on its own with
  // an exit its host reported, as one that ended while its host slept does;
  // a stop, a sleep, or another revive that took the session leaves it
  private async isHarnessRestartable(s: Session, pty: HarnessHandle): Promise<boolean> {
    if (s.pty === pty) {
      return true;
    }

    if (s.pty !== null) {
      return false;
    }

    const exited = await pty.waitForExit(0);

    return (
      exited &&
      s.pty === null &&
      s.desired === 'run' &&
      !s.suspended &&
      !this.adopting.has(s.id) &&
      this.registry.sessions.includes(s)
    );
  }

  // a harness from before a rebind keeps the guest settings it launched
  // under; the host counts as readying throughout, so it is never idle
  // between the two harnesses and no other revive of the session starts
  private async restartOutdatedHarness(
    s: Session,
    outdated: HarnessHandle,
    launch: HarnessLaunch,
    canProceed: () => boolean,
  ): Promise<HarnessHandle> {
    this.adopting.add(s.id);

    try {
      return await this.harnesses.withHostReadying(s.hostKey, () =>
        this.restartHarnessOnHost(s, outdated, launch, canProceed),
      );
    } finally {
      this.adopting.delete(s.id);
    }
  }

  // a kill whose exit atc cannot confirm blocks revives until the process
  // is gone; a stop, a rollback, or a change out of the caller's reach
  // while the kill waits starts nothing
  private async restartHarnessOnHost(
    s: Session,
    outdated: HarnessHandle,
    launch: HarnessLaunch,
    canProceed: () => boolean,
  ): Promise<HarnessHandle> {
    // The outdated harness stops being the session's terminal first, so
    // its exit leaves the session as it is.
    s.pty = null;

    const settled = Promise.withResolvers<void>();
    const restart: HarnessRestart = { session: s, stopped: false, settled: settled.promise };

    this.restarts.set(s.id, restart);

    let exited = false;

    try {
      exited = await this.rollback.killHarness(s.id, outdated);

      if (
        exited &&
        !restart.stopped &&
        canProceed() &&
        s.pty === null &&
        this.registry.sessions.includes(s) &&
        !this.rollback.rollingBack.has(s.id)
      ) {
        return this.startHarness(s, launch);
      }
    } finally {
      // every path that starts no harness, a throwing kill included, writes
      // the session stopped to the fleet before the adopt answers, so a
      // restore after a daemon restart does not revive it
      try {
        if (s.pty === null) {
          s.state = 'exited';
          s.lastMsg = 'killed';
          s.desired = 'stop';

          this.callbacks.onEvent('state', s);

          await this.fleet.tryWriteFleet(s.id);

          this.fleet.emitChange();
        }
      } finally {
        this.restarts.delete(s.id);
        settled.resolve();
      }
    }

    if (!exited) {
      throw new DaemonError(
        'session_dead',
        `session ${s.id} still runs a harness from an older auth revision that did not exit after its kill; adopt it again once that process is gone`,
        { session: s.id },
      );
    }

    throw new DaemonError('no_such_session', `session ${s.id} changed during its restart`, {
      session: s.id,
    });
  }
}

// the held revision is the host's from before the revive, used when the
// session recorded none at its latest launch
function isLaunchOutdated(s: Session, revision: number, heldRevision: number | null): boolean {
  return (s.authRevision ?? heldRevision ?? revision) < revision;
}
