import { socketPath } from '@atc/config';
import { createStepTimer } from '@atc/core';
import type { SessionID } from '@atc/core';
import type { ExecutionProvider, HarnessHandle } from '@atc/plugin-api';
import { buildSessionEnv } from '@atc/protocol/session';
import { DaemonError } from '@atc/protocol/wire';
import { resolveRepoRoot } from '../shared/resolve-repo-root';
import type { AuthSetup, HarnessAuthSetup, HarnessPlan } from './auth-setup';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionFleetWriter } from './session-fleet-writer';
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
    'onBoot' | 'onEvent' | 'onRelay' | 'log' | 'now' | 'getRecords'
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

/**
 * Revives a session into a terminal: a fresh harness resumes the same
 * agent session, and on a remote host the host wakes first, attaching a
 * harness it still runs and reviving every session left asleep beside it.
 */
export class SessionAdopter {
  // Sessions whose revive waits on their host waking, so a second revive
  // of the same session does not start a second harness.
  private readonly adopting = new Set<SessionID>();

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

  // Adopts a headless session back into a terminal: a fresh PTY resumes the
  // same agent session id. On a remote host the host wakes first, and a
  // harness still running inside it is attached rather than started again;
  // every other session left asleep on that host comes back with it. The
  // caller's check runs again after each await, and a failed check leaves
  // the session as it was.
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
    } finally {
      this.adopting.delete(id);
    }

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

    const launch: HarnessLaunch = { provider, plan, recordPath, cols, rows };
    let pty = this.startHarness(s, launch);

    let start = await timer.withStep('harness-start', () =>
      auth === null
        ? Promise.resolve(undefined)
        : this.harnesses.waitForAuthStart(s, provider, pty),
    );

    if (
      plan.admission !== null &&
      start?.created === false &&
      wasAsleep &&
      s.pty === pty &&
      isLaunchOutdated(s, plan.admission.revision, plan.heldRevision)
    ) {
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

  // Ends a harness the host still ran from before a rebind, since it keeps
  // the guest settings of the revision it launched under, and starts a
  // fresh one that resumes the same agent session under the plan's
  // revision. The host counts as readying throughout, so it is never idle
  // between the two, and no other revive of the session starts meanwhile.
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

  // A kill whose exit atc cannot confirm blocks the session's revives
  // until the process is gone. A kill, a rollback, or a change that takes
  // the session out of the caller's reach while the kill waits starts
  // nothing.
  private async restartHarnessOnHost(
    s: Session,
    outdated: HarnessHandle,
    launch: HarnessLaunch,
    canProceed: () => boolean,
  ): Promise<HarnessHandle> {
    // The outdated harness stops being the session's terminal first, so
    // its exit leaves the session as it is.
    s.pty = null;

    let exited = false;

    try {
      exited = await this.rollback.killHarness(s.id, outdated);

      if (
        exited &&
        canProceed() &&
        s.pty === null &&
        this.registry.sessions.includes(s) &&
        !this.rollback.rollingBack.has(s.id)
      ) {
        return this.startHarness(s, launch);
      }
    } finally {
      // Every path that starts no harness, a kill that throws included,
      // leaves the session stopped, as a deliberate kill does, and writes
      // that to the fleet before the adopt answers, so a restore after a
      // daemon restart does not revive it.
      if (s.pty === null) {
        s.state = 'exited';
        s.lastMsg = 'killed';
        s.desired = 'stop';

        this.callbacks.onEvent('state', s);

        await this.fleet.tryWriteFleet(s.id);

        this.fleet.emitChange();
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

// Whether the process a revive attached to launched under an older runtime
// auth revision than the one the revive launches under: the revision the
// session recorded at its latest launch, or else the one its host held
// before the revive.
function isLaunchOutdated(s: Session, revision: number, heldRevision: number | null): boolean {
  return (s.authRevision ?? heldRevision ?? revision) < revision;
}
