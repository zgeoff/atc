import { createStepTimer } from '@atc/core';
import type { ExecutionProvider, HarnessHandle } from '@atc/plugin-api';
import { buildSessionEnv } from '@atc/protocol/session';
import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import type { AuthSetup, HarnessAuthSetup, HarnessPlan } from '../auth/create-auth-setup';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import { buildRecordSubject } from './build-record-subject';
import type { SessionHarnesses } from './create-session-harnesses';
import type { SessionRegistry } from './create-session-registry';
import type { SpawnRollback } from './create-spawn-rollback';
import { requirePluginDirsOnTarget } from './require-plugin-dirs-on-target';
import { resolveRepoRoot } from './resolve-repo-root';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';

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
    'rollingBack' | 'unconfirmedKills' | 'probeRollbackSettled' | 'killHarness'
  >;
  readonly auth: Pick<AuthSetup, 'buildBrokerSpec' | 'resolveHarnessAuth' | 'setupHarnessOnHost'>;
  readonly callbacks: Pick<
    SessionCallbacks,
    | 'onBoot'
    | 'onEvent'
    | 'onRelay'
    | 'log'
    | 'now'
    | 'getReporterSocketPath'
    | 'findRecords'
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

export interface SessionAdopter {
  // resolves once the waiting restart leaves the session stopped and written
  // to the fleet; false, touching nothing, when no restart waits
  readonly stopRestart: (id: SessionID) => Promise<boolean>;

  // a remote host wakes first, attaching a harness it still runs and
  // reviving every session asleep beside it; the caller's check runs again
  // after each await, and a failed check leaves the session as it was
  readonly adoptTerminal: (
    id: SessionID,
    cols: number,
    rows: number,
    canProceed?: () => boolean,
  ) => Promise<Session | null>;
}

export function createSessionAdopter(deps: SessionAdopterDeps): SessionAdopter {
  // Sessions whose revive waits on their host waking, so a second revive
  // of the same session does not start a second harness.
  const adopting = new Set<SessionID>();

  // Sessions whose outdated harness waits on its kill before the restart
  // starts a fresh one, each with whether a stop landed meanwhile and a
  // promise that settles once the restart leaves the session as it ends.
  const restarts = new Map<SessionID, HarnessRestart>();

  const registry = deps.registry;
  const fleet = deps.fleet;
  const harnesses = deps.harnesses;
  const rollback = deps.rollback;
  const auth = deps.auth;
  const callbacks = deps.callbacks;

  // Starts the harness that revives a session, or attaches the one its
  // host still runs, and follows it as the session's terminal.
  const startHarness = (session: Session, launch: HarnessLaunch): HarnessHandle => {
    const plan = launch.plan;
    const provider = launch.provider;

    const binding = harnesses.mintBridgeBinding(
      session.id,
      session.target,
      session.targetIdentity,
      session.hostKey,
    );

    const pty = provider.spawnHarness({
      session: session.id,
      host: session.hostKey,
      bin: plan.bin,
      args: plan.args,
      cwd: session.cwd,
      env: {
        ...plan.env,
        ...buildSessionEnv({
          sessionID: session.id,
          socket: callbacks.getReporterSocketPath(),
          ...(launch.recordPath === null ? {} : { sessionRecord: launch.recordPath }),
        }),
      },
      withheldEnv: session.withheldEnv,
      cols: launch.cols,
      rows: launch.rows,
      ...auth.buildBrokerSpec(session.hostKey, plan.admission),
      onRelay: (relay) => {
        callbacks.onRelay(binding, relay);
      },
    });

    session.bridgeEpoch = binding.epoch;
    session.pty = pty;
    session.kind = 'pty';
    session.state = 'running';
    session.lastMsg = 'revived';

    registry.unrestored.delete(session.id);

    if (plan.admission === null) {
      delete session.authRevision;
    }

    session.repoRoot = provider.remote ? session.cwd : resolveRepoRoot(session.cwd);
    session.desired = 'run';
    session.suspended = false;

    harnesses.attachHarness(session, pty, registry.hasHostLifecycle(session.target));
    callbacks.onBoot(session, launch.cols, launch.rows);
    void fleet.tryWriteFleet(session.id);
    callbacks.onEvent('state', session);
    fleet.emitChange();

    return pty;
  };

  // the harness is still the session's terminal, or ended on its own with
  // an exit its host reported, as one that ended while its host slept does;
  // a stop, a sleep, or another revive that took the session leaves it
  const probeHarnessRestartable = async (
    session: Session,
    pty: HarnessHandle,
  ): Promise<boolean> => {
    if (session.pty === pty) {
      return true;
    }

    if (session.pty !== null) {
      return false;
    }

    const exited = await pty.waitForExit(0);

    return (
      exited &&
      session.pty === null &&
      session.desired === 'run' &&
      !session.suspended &&
      !adopting.has(session.id) &&
      registry.sessions.includes(session)
    );
  };

  // a kill whose exit atc cannot confirm blocks revives until the process
  // is gone; a stop, a rollback, or a change out of the caller's reach
  // while the kill waits starts nothing
  const restartHarnessOnHost = async (
    session: Session,
    outdated: HarnessHandle,
    launch: HarnessLaunch,
    canProceed: () => boolean,
  ): Promise<HarnessHandle> => {
    // The outdated harness stops being the session's terminal first, so
    // its exit leaves the session as it is.
    session.pty = null;

    const settled = Promise.withResolvers<void>();
    const restart: HarnessRestart = { session, stopped: false, settled: settled.promise };

    restarts.set(session.id, restart);

    let exited = false;

    try {
      exited = await rollback.killHarness(session.id, outdated);

      if (
        exited &&
        !restart.stopped &&
        canProceed() &&
        session.pty === null &&
        registry.sessions.includes(session) &&
        !rollback.rollingBack.has(session.id)
      ) {
        return startHarness(session, launch);
      }
    } finally {
      // every path that starts no harness, a throwing kill included, writes
      // the session stopped to the fleet before the adopt answers, so a
      // restore after a daemon restart does not revive it
      try {
        if (session.pty === null) {
          session.state = 'exited';
          session.lastMsg = 'killed';
          session.desired = 'stop';

          callbacks.onEvent('state', session);

          await fleet.tryWriteFleet(session.id);

          fleet.emitChange();
        }
      } finally {
        restarts.delete(session.id);
        settled.resolve();
      }
    }

    if (!exited) {
      throw new DaemonError(
        'session_dead',
        `session ${session.id} still runs a harness from an older auth revision that did not exit after its kill; adopt it again once that process is gone`,
        { session: session.id },
      );
    }

    throw new DaemonError('no_such_session', `session ${session.id} changed during its restart`, {
      session: session.id,
    });
  };

  // a harness from before a rebind keeps the guest settings it launched
  // under; the host counts as readying throughout, so it is never idle
  // between the two harnesses and no other revive of the session starts
  const restartOutdatedHarness = async (
    session: Session,
    outdated: HarnessHandle,
    launch: HarnessLaunch,
    canProceed: () => boolean,
  ): Promise<HarnessHandle> => {
    adopting.add(session.id);

    try {
      return await harnesses.withHostReadying(session.hostKey, () =>
        restartHarnessOnHost(session, outdated, launch, canProceed),
      );
    } finally {
      adopting.delete(session.id);
    }
  };

  const adoptTerminal = async (
    id: SessionID,
    cols: number,
    rows: number,
    canProceed: () => boolean = () => true,
  ): Promise<Session | null> => {
    const session = registry.sessions.find((x) => x.id === id);

    if (
      !session ||
      session.pty !== null ||
      session.agentSessionID === undefined ||
      adopting.has(id)
    ) {
      return null;
    }

    // Only a harness that sleeps inside its host restarts when it launched
    // under an older revision: one that runs, such as a harness a restore
    // finds after a daemon restart, may be inside a turn a restart ends.
    const wasAsleep = session.suspended;

    const settled = await rollback.probeRollbackSettled(id);

    if (!settled || !canProceed()) {
      return null;
    }

    const adapter = registry.findAdapter(session.agent);

    if (adapter === null) {
      return null;
    }

    const provider = registry.requireExecution(session, 'spawn').provider;

    // the config's folders may have changed since the spawn, so a revive
    // checks them again rather than starting the session without them
    requirePluginDirsOnTarget(
      [...(adapter.profile?.pluginDirs ?? []), ...(session.pluginDirs ?? [])],
      session.target,
      provider.remote,
    );

    const harnessAuth = auth.resolveHarnessAuth(adapter, provider, session.target);
    const timer = createStepTimer(callbacks.now);

    const authSetup: HarnessAuthSetup | null =
      harnessAuth === null
        ? null
        : { ...harnessAuth, mode: 'verify', targetIdentity: session.targetIdentity };

    adopting.add(id);

    let plan: HarnessPlan;
    let recordPath: string | null;
    const resume = session.agentSessionID;

    // The record is placed again while the host still counts as readying,
    // so a host that lost its copy, such as one that booted cold, has it
    // back before the harness starts.
    try {
      const setup = await harnesses.withHostReadying(session.hostKey, async () => {
        const planned = await auth.setupHarnessOnHost(
          adapter,
          provider,
          session.id,
          session.hostKey,
          session.target,
          {
            prompt: '',
            resume,
            ...(session.model === undefined ? {} : { model: session.model }),
            ...(session.effort === undefined ? {} : { effort: session.effort }),
            ...(session.pluginDirs === undefined ? {} : { pluginDirs: session.pluginDirs }),
          },
          authSetup,
          session.cwd,
          false,
          timer,
        );

        const records = callbacks.findRecords();

        const path =
          records === null
            ? null
            : await timer.withStep('record', () =>
                records.restoreCopy(buildRecordSubject(session, provider)),
              );

        return { plan: planned.plan, recordPath: path };
      });

      plan = setup.plan;
      recordPath = setup.recordPath;
    } catch (error) {
      adopting.delete(id);
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
        session.pty !== null ||
        !registry.sessions.includes(session) ||
        rollback.rollingBack.has(id) ||
        rollback.unconfirmedKills.has(id)
      ) {
        return null;
      }

      // the bridge starts first, on the thread the session resumes, so the
      // terminal starts against it; a change that lands while it starts
      // stops it again
      if (!provider.remote) {
        const bridged = await callbacks.startMessageBridge({
          adapter,
          session: session.id,
          cwd: session.cwd,
          env: {
            ...plan.env,
            ...buildSessionEnv({
              sessionID: session.id,
              socket: callbacks.getReporterSocketPath(),
              ...(recordPath === null ? {} : { sessionRecord: recordPath }),
            }),
          },
          withheldEnv: session.withheldEnv,
          options: {
            prompt: '',
            resume,
            ...(session.model === undefined ? {} : { model: session.model }),
            ...(session.effort === undefined ? {} : { effort: session.effort }),
            ...(session.pluginDirs === undefined ? {} : { pluginDirs: session.pluginDirs }),
          },
        });

        if (
          !canProceed() ||
          session.pty !== null ||
          !registry.sessions.includes(session) ||
          rollback.rollingBack.has(id) ||
          rollback.unconfirmedKills.has(id)
        ) {
          await callbacks.stopMessageBridge(session.id);

          return null;
        }

        plan = bridged === null ? plan : { ...plan, bin: bridged.bin, args: bridged.args };
      }

      launch = { provider, plan, recordPath, cols, rows };

      // A terminal that fails to start leaves no message bridge running
      // without it.
      try {
        pty = startHarness(session, launch);
      } catch (error) {
        await callbacks.stopMessageBridge(session.id);

        throw error;
      }
    } finally {
      adopting.delete(id);
    }

    let start = await timer.withStep('harness-start', () =>
      harnessAuth === null
        ? Promise.resolve(undefined)
        : harnesses.waitForAuthStart(session, provider, pty),
    );

    const outdated =
      plan.admission !== null &&
      start?.created === false &&
      wasAsleep &&
      isLaunchOutdated(session, plan.admission.revision, plan.heldRevision);

    const restartable = outdated ? await probeHarnessRestartable(session, pty) : false;

    if (restartable) {
      pty = await restartOutdatedHarness(session, pty, launch, canProceed);

      start = await timer.withStep('harness-restart', () =>
        harnesses.waitForAuthStart(session, provider, pty),
      );
    }

    if (plan.admission !== null) {
      harnesses.updateLaunchRevision(
        session,
        plan.admission.revision,
        plan.heldRevision,
        start?.created ?? true,
      );
    }

    if (provider.remote) {
      callbacks.log(
        `atc: wake of session ${session.id} on target '${session.target}' took ${timer.formatSteps()}`,
      );
    }

    for (const asleep of registry.sessions) {
      if (
        asleep.hostKey === session.hostKey &&
        asleep.target === session.target &&
        asleep.suspended
      ) {
        await tryAdoptSibling(asleep, session, cols, rows);
      }
    }

    return session;
  };

  // A sibling's revive failing leaves that sibling asleep; the session
  // whose revive woke the host is already running, so the failure is
  // logged rather than thrown.
  const tryAdoptSibling = async (
    sibling: Session,
    session: Session,
    cols: number,
    rows: number,
  ): Promise<void> => {
    try {
      await adoptTerminal(sibling.id, cols, rows);
    } catch (error) {
      callbacks.log(
        `atc could not revive session ${sibling.id} beside ${session.id} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  };

  return {
    stopRestart: async (id) => {
      const restart = restarts.get(id);

      if (restart === undefined) {
        return false;
      }

      if (!restart.stopped) {
        restart.stopped = true;
        restart.session.lastMsg = 'stopping';

        callbacks.onEvent('state', restart.session);
      }

      await restart.settled;

      return true;
    },

    adoptTerminal,
  };
}

// the held revision is the host's from before the revive, used when the
// session recorded none at its latest launch
function isLaunchOutdated(
  session: Session,
  revision: number,
  heldRevision: number | null,
): boolean {
  return (session.authRevision ?? heldRevision ?? revision) < revision;
}
