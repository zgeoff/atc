import { createStepTimer } from '@atc/core';
import type { HarnessHandle, HarnessStart } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import type { AuthSetup } from '../auth/create-auth-setup';
import type { HarnessAuthSetup, HarnessPlan } from '../auth/types';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import { buildHarnessEnv } from './build-harness-env';
import { buildRecordSubject } from './build-record-subject';
import type { HarnessFates } from './create-harness-fates';
import type { SessionHarnesses } from './create-session-harnesses';
import type { SessionRegistry } from './create-session-registry';
import type { SpawnRollback } from './create-spawn-rollback';
import { pickAdoptedAgentHome } from './pick-adopted-agent-home';
import { requirePluginDirsOnTarget } from './require-plugin-dirs-on-target';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import { startReviveHarness } from './start-revive-harness';
import type { HarnessLaunch } from './types';

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

  readonly fates?: Pick<HarnessFates, 'readFates'>;
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

interface HarnessRestart {
  readonly session: Session;
  stopped: boolean;
  readonly settled: Promise<void>;
}

export interface SessionAdopter {
  readonly stopRestart: (id: SessionID) => Promise<boolean>;

  readonly adoptTerminal: (
    id: SessionID,
    cols: number,
    rows: number,
    canProceed?: () => boolean,
  ) => Promise<Session | null>;
}

export function createSessionAdopter(deps: SessionAdopterDeps): SessionAdopter {
  const adopting = new Set<SessionID>();
  const restarts = new Map<SessionID, HarnessRestart>();

  const registry = deps.registry;
  const fleet = deps.fleet;
  const harnesses = deps.harnesses;
  const rollback = deps.rollback;
  const auth = deps.auth;
  const fates = deps.fates;
  const callbacks = deps.callbacks;

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
        return startReviveHarness(deps, session, launch);
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

  // The host stays readying across both harnesses so it is never idle between them and no other
  // revive of the session starts.
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
        const planned = await auth.setupHarnessOnHost({
          adapter,
          provider,
          id: session.id,
          hostKey: session.hostKey,
          target: session.target,
          spawnOptions: {
            prompt: '',
            resume,
            ...(session.model === undefined ? {} : { model: session.model }),
            ...(session.effort === undefined ? {} : { effort: session.effort }),
            ...(session.pluginDirs === undefined ? {} : { pluginDirs: session.pluginDirs }),
            ...(session.atcAccess === undefined ? {} : { atcMCP: true }),
          },
          auth: authSetup,
          cwd: session.cwd,
          isNewHost: false,
          timer,
        });

        void fates?.readFates({ hostKey: session.hostKey, except: session.id });
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

    try {
      if (
        !canProceed() ||
        session.pty !== null ||
        !registry.sessions.includes(session) ||
        rollback.rollingBack.has(id) ||
        rollback.unconfirmedKills.has(id)
      ) {
        return null;
      }

      if (!provider.remote) {
        const bridged = await callbacks.startMessageBridge({
          adapter,
          session: session.id,
          cwd: session.cwd,
          env: buildHarnessEnv(
            plan.env,
            {
              sessionID: session.id,
              socket: callbacks.getReporterSocketPath(),
              ...(recordPath === null ? {} : { sessionRecord: recordPath }),
            },
            { daemonEnv: process.env, withheldEnv: session.withheldEnv },
          ),
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

      try {
        pty = startReviveHarness(deps, session, launch);
      } catch (error) {
        await callbacks.stopMessageBridge(session.id);

        throw error;
      }
    } finally {
      adopting.delete(id);
    }

    let start = await timer.withStep('harness-start', () =>
      harnessAuth?.kind === 'broker'
        ? harnesses.waitForAuthStart(session, provider, pty)
        : Promise.resolve(undefined),
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

    const plannedHome = plan.agentHome;
    const startedPty = pty;

    const updateAgentHome = (harnessStart: HarnessStart | undefined): void => {
      const agentHome = pickAdoptedAgentHome(harnessStart, session.agentHome, plannedHome);

      if (session.pty !== startedPty || session.agentHome === agentHome) {
        return;
      }

      session.agentHome = agentHome;
      void fleet.tryWriteFleet(session.id);
    };

    const followAgentHome = async (): Promise<void> => {
      try {
        const harnessStart = await startedPty.waitForStart?.();

        updateAgentHome(harnessStart);
      } catch {
        // a harness that never starts runs no agent, so the home it would have used stays unread
      }
    };

    if (start === undefined && pty.waitForStart !== undefined) {
      void followAgentHome();
    } else {
      updateAgentHome(start);
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
