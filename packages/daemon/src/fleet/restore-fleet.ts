import type { Clock } from '@atc/core';
import { systemClock } from '@atc/core';
import type { HarnessHandle } from '@atc/plugin-api';
import type { FleetEntry, StateStore } from '@atc/store';
import type { SessionID } from '@atcx/contract';
import type { SessionManager } from '../sessions/create-session-manager';
import type { SessionRuntime } from '../sessions/create-session-runtime';
import type { Session } from '../sessions/session';
import { formatRestoreRefusal } from './format-restore-refusal';
import { formatRestoreReport } from './format-restore-report';
import type { RestoreLane, RestoreLaneReport } from './format-restore-report';
import { getTopLevelSession } from './get-top-level-session';
import { isOnEntryTarget } from './is-on-entry-target';
import { isSameSession } from './is-same-session';
import { tryAdoptTerminal } from './try-adopt-terminal';
import type { AdoptResult } from './types';

interface RestoreFleetParams {
  readonly manager: SessionManager;
  readonly store: StateStore;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;
  readonly cols: number;
  readonly rows: number;

  readonly capMs: number;

  readonly isStopped?: () => boolean;

  readonly retryDelaysMs?: readonly number[];

  readonly clock?: Clock;
}

const RESTORE_RETRY_DELAYS_MS: readonly number[] = [5000, 15_000, 45_000];
const RESTORE_LANES: readonly RestoreLane[] = ['local', 'remote'];
const RETRY_SLICE_MS = 1000;

type RestoreOutcome = 'finished' | 'stopped' | 'failed';

type RoundEnd =
  | { readonly stopped: true }
  | {
      readonly stopped: false;
      readonly last: Session | null;
      readonly retrying: readonly Session[];
    };

interface BootWatch {
  readonly released: Promise<void>;
  readonly recorded: Promise<void>;
  readonly stop: () => void;
}

const SETTLED_BOOT: BootWatch = {
  released: Promise.resolve(),
  recorded: Promise.resolve(),
  stop: () => {},
};

type QueuedTry = 'started' | 'skipped' | 'retrying';

export interface RestoreSettled {
  readonly restored: number;
  readonly outcome: RestoreOutcome;
}

interface RestoreFleetResult {
  readonly restored: number;

  readonly settled: Promise<RestoreOutcome>;
}

const RETRIED_ADOPT_CODES: ReadonlySet<string> = new Set(['host_unavailable', 'broker_not_ready']);

interface RecordRefusalOptions {
  readonly reason: string;
  readonly code: string | null;
  readonly retry: boolean;
  readonly unchanged: boolean;
}

export async function restoreFleet(params: RestoreFleetParams): Promise<RestoreFleetResult> {
  const manager = params.manager;
  const store = params.store;
  const findRuntime = params.findRuntime;
  const cols = params.cols;
  const rows = params.rows;
  const capMs = params.capMs;
  const clock = params.clock ?? systemClock;
  const retryDelaysMs = params.retryDelaysMs ?? RESTORE_RETRY_DELAYS_MS;
  const isStopped = () => params.isStopped?.() === true;
  const beganAtMs = clock.now();

  // A session whose terminal an earlier restore could not start is not live until a headless turn
  // starts for it. A session that resumed the same agent session on another target does not count,
  // because the fleet keeps one row per target.
  const hasLiveSession = (entry: FleetEntry) =>
    manager.sessions.some(
      (session) =>
        isSameSession(session, entry) &&
        (session.id === entry.sessionID || isOnEntryTarget(session, entry)) &&
        (session.pty !== null ||
          (session.kind === 'headless' &&
            session.state !== 'exited' &&
            !manager.isUnrestored(session.id))),
    );

  const hasAnySession = (entry: FleetEntry) =>
    manager.sessions.some((session) => isSameSession(session, entry));

  const findRecency = (entry: FleetEntry) =>
    entry.agentSessionID === undefined ? '' : (recency.get(entry.agentSessionID) ?? '');

  const recency = await store.readFleetRecency();
  const stored = await store.loadFleet();

  const kept = stored
    .filter((entry) => (entry.exited === true ? !hasAnySession(entry) : !hasLiveSession(entry)))
    .toSorted((left, right) => findRecency(right).localeCompare(findRecency(left)));

  const entries = [
    ...kept.filter((entry) => entry.parent === undefined),
    ...kept.filter((entry) => entry.parent !== undefined),
  ];

  const registered: { session: Session; revive: boolean }[] = [];

  for (const entry of entries) {
    try {
      const listed = manager.sessions.find((session) => session.id === entry.sessionID);

      const binding =
        listed === undefined
          ? entry
          : {
              ...entry,
              target: listed.target,
              targetIdentity: listed.targetIdentity,
              hostKey: listed.hostKey,
            };

      const resolved = await manager.resolveRestoredEntry(binding);

      if (listed !== undefined && resolved.targetIdentity !== undefined) {
        manager.updateRestoredIdentity(listed, resolved.targetIdentity);
      }

      if (listed === undefined) {
        const attention = await store.readLatestAttention(
          resolved.sessionID,
          resolved.agentSessionID,
        );

        registered.push({ session: manager.restore(resolved, attention), revive: false });
      } else {
        registered.push({ session: listed, revive: true });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      manager.log(`atc could not restore session ${entry.sessionID} (${reason})`);
    }
  }

  void manager.readHarnessFates();

  const queued = registered
    .filter((row) => row.revive || row.session.state !== 'exited')
    .map((row) => row.session);

  // A headless turn clears a session's unrestored mark. A marked session that lost the mark
  // without a terminal is running a turn, so the restore starts no terminal beside it.
  const markedAtQueue = new Set(queued.filter((session) => manager.isUnrestored(session.id)));

  const hasHeadlessTurnStarted = (session: Session) =>
    markedAtQueue.has(session) && session.pty === null && !manager.isUnrestored(session.id);

  const attached = new Set<SessionID>();
  const startTimes = new Map<SessionID, number>();
  const boots = new Map<SessionID, BootWatch>();

  const watchHarnessStart = async (
    sessionID: SessionID,
    harness: HarnessHandle,
    release: () => void,
  ): Promise<void> => {
    try {
      const start = await harness.waitForStart?.();

      if (start?.created === false) {
        attached.add(sessionID);

        release();
      }
    } catch {
      release();
    }
  };

  const watchBoot = (session: Session): BootWatch => {
    const runtime = findRuntime(session.id);
    const harness = session.pty;

    if (runtime === undefined || harness === null) {
      return SETTLED_BOOT;
    }

    if (runtime.startedAt !== null) {
      startTimes.set(session.id, runtime.startedAt);

      return SETTLED_BOOT;
    }

    const recorded = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const cancelCap = capMs > 0 ? clock.schedule(released.resolve, capMs) : null;

    const stop = () => {
      if (runtime.bootWaiter === waiter) {
        runtime.bootWaiter = null;
      }

      cancelCap?.();
      recorded.resolve();
      released.resolve();
    };

    const waiter = () => {
      if (runtime.startedAt !== null) {
        startTimes.set(session.id, runtime.startedAt);
      }

      stop();
    };

    runtime.bootWaiter = waiter;
    void watchHarnessStart(session.id, harness, stop);

    return { released: released.promise, recorded: recorded.promise, stop };
  };

  const waitForBoot = (sessionID: SessionID): Promise<void> =>
    boots.get(sessionID)?.released ?? Promise.resolve();

  const [first] = queued;

  if (first === undefined) {
    manager.log(formatRestoreReport(registered.length, []));

    return { restored: registered.length, settled: Promise.resolve('finished') };
  }

  const pickLane = (session: Session): RestoreLane =>
    manager.findProvider(getTopLevelSession(session, manager.sessions))?.remote === true
      ? 'remote'
      : 'local';

  const lanes = Map.groupBy(queued, pickLane);

  const started = new Set<Session>();

  let failed = false;

  const refusals = new Map<Session, string>();

  const recordRefusal = (session: Session, options: RecordRefusalOptions): QueuedTry => {
    const listed = options.unchanged && session.pty === null && manager.sessions.includes(session);
    const retried = options.retry && listed;
    const suffix = retried ? '; trying again' : '';

    manager.log(`atc could not revive session ${session.id} (${options.reason})${suffix}`);

    if (listed) {
      const finalCode = retried ? null : options.code;

      manager.updateRestoreRefusal(session, options.reason, finalCode);
      refusals.set(session, options.reason);
    }

    return retried ? 'retrying' : 'skipped';
  };

  const tryAdoptQueued = async (
    session: Session,
    canRetry: boolean,
    isEligible: (session: Session) => boolean,
  ): Promise<QueuedTry> => {
    let adopted: AdoptResult;
    const before = { state: session.state, lastMsg: session.lastMsg };
    const isUnchanged = () => session.state === before.state && session.lastMsg === before.lastMsg;

    try {
      adopted = await tryAdoptTerminal(manager, {
        id: session.id,
        cols,
        rows,
        canProceed: () => !isStopped() && isEligible(session) && !hasHeadlessTurnStarted(session),
      });
    } catch (error) {
      failed = true;

      const reason = error instanceof Error ? error.message : String(error);

      return recordRefusal(session, {
        reason,
        code: null,
        retry: false,
        unchanged: isUnchanged(),
      });
    }

    if (adopted.kind === 'refused') {
      return recordRefusal(session, {
        reason: formatRestoreRefusal(session.id, adopted.refusal),
        code: adopted.refusal.code,
        retry: canRetry && RETRIED_ADOPT_CODES.has(adopted.refusal.code),
        unchanged: isUnchanged(),
      });
    }

    if (adopted.session === null) {
      return 'skipped';
    }

    started.add(session);
    boots.set(session.id, watchBoot(session));

    return 'started';
  };

  const firstTried = Promise.withResolvers<void>();

  const adoptEach = async (
    sessions: readonly Session[],
    previous: Session | null,
    canRetry: boolean,
    isEligible: (session: Session) => boolean,
  ): Promise<RoundEnd> => {
    let lastStarted = previous;
    const retrying: Session[] = [];

    for (const session of sessions) {
      if (lastStarted !== null) {
        await waitForBoot(lastStarted.id);
      }

      if (isStopped()) {
        return { stopped: true };
      }

      const tried =
        !isEligible(session) || hasHeadlessTurnStarted(session)
          ? 'skipped'
          : await tryAdoptQueued(session, canRetry, isEligible);

      if (session === first) {
        firstTried.resolve();
      }

      if (isStopped()) {
        return { stopped: true };
      }

      if (tried === 'retrying') {
        retrying.push(session);
      }

      lastStarted = tried === 'started' ? session : null;
    }

    return { stopped: false, last: lastStarted, retrying };
  };

  const waitForRetry = async (delayMs: number): Promise<boolean> => {
    const due = clock.now() + delayMs;

    while (!isStopped() && clock.now() < due) {
      await new Promise<void>((resolve) => {
        clock.schedule(resolve, Math.min(RETRY_SLICE_MS, due - clock.now()));
      });
    }

    return !isStopped();
  };

  const isStillRefused = (session: Session) =>
    session.pty === null &&
    manager.sessions.includes(session) &&
    session.lastMsg === refusals.get(session);

  const adoptLane = async (sessions: readonly Session[]): Promise<RestoreOutcome> => {
    let ended = await adoptEach(sessions, null, retryDelaysMs.length > 0, () => true);

    for (const [round, delayMs] of retryDelaysMs.entries()) {
      if (ended.stopped || ended.retrying.length === 0) {
        break;
      }

      if (!(await waitForRetry(delayMs))) {
        return 'stopped';
      }

      const canRetry = round + 1 < retryDelaysMs.length;

      ended = await adoptEach(ended.retrying, ended.last, canRetry, isStillRefused);
    }

    return ended.stopped ? 'stopped' : 'finished';
  };

  const adoptLaneLogged = async (sessions: readonly Session[]): Promise<RestoreOutcome> => {
    try {
      return await adoptLane(sessions);
    } catch (error) {
      manager.log(
        `atc could not finish restoring the fleet (${error instanceof Error ? error.message : String(error)})`,
      );

      return 'failed';
    }
  };

  const collectLaneReports = (): RestoreLaneReport[] =>
    RESTORE_LANES.filter((lane) => lanes.has(lane)).map((lane) => {
      const terminals = (lanes.get(lane) ?? []).filter((session) => started.has(session));

      const laneStarts = terminals
        .map((session) => startTimes.get(session.id))
        .filter((startedAt) => startedAt !== undefined);

      return {
        lane,
        terminals: terminals.length,
        attached: terminals.filter((session) => attached.has(session.id)).length,
        started: laneStarts.length,
        lastStartMs: laneStarts.length === 0 ? null : Math.max(...laneStarts) - beganAtMs,
      };
    });

  const settleLanes = async (): Promise<RestoreOutcome> => {
    const ends = await Promise.all(
      [...lanes.values()].map((sessions) => adoptLaneLogged(sessions)),
    );

    const outcome = pickRestoreOutcome(ends, failed);

    if (outcome !== 'stopped') {
      void writeReportOnceBooted();
    }

    return outcome;
  };

  const writeReportOnceBooted = async (): Promise<void> => {
    const cap = Promise.withResolvers<void>();
    const cancelCap = capMs > 0 ? clock.schedule(cap.resolve, capMs) : null;
    const watches = [...boots.values()];

    await Promise.race([Promise.all(watches.map((watch) => watch.recorded)), cap.promise]);

    cancelCap?.();

    for (const watch of watches) {
      watch.stop();
    }

    if (!isStopped()) {
      manager.log(formatRestoreReport(registered.length, collectLaneReports()));
    }
  };

  if (isStopped()) {
    return { restored: registered.length, settled: Promise.resolve('stopped') };
  }

  const settled = settleLanes();

  await Promise.race([firstTried.promise, settled]);

  return { restored: registered.length, settled };
}

function pickRestoreOutcome(ends: readonly RestoreOutcome[], failed: boolean): RestoreOutcome {
  if (ends.includes('stopped')) {
    return 'stopped';
  }

  return failed || ends.includes('failed') ? 'failed' : 'finished';
}
