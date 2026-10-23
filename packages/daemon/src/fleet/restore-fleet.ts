import type { Clock, SessionID } from '@atc/core';
import { systemClock } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import type { ErrorCode } from '@atc/protocol/wire';
import type { FleetEntry, StateStore } from '@atc/store';
import type { SessionManager } from '../sessions/create-session-manager';
import type { SessionRuntime } from '../sessions/create-session-runtime';
import type { Session } from '../sessions/session';
import { formatRestoreRefusal } from './format-restore-refusal';

interface RestoreFleetParams {
  readonly manager: SessionManager;
  readonly store: StateStore;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;
  readonly cols: number;
  readonly rows: number;

  // Caps how long a staggered restore waits for a revived session to report
  // it has booted before moving on regardless; zero waits on the signal
  // alone.
  readonly capMs: number;

  // Whether the daemon has begun to stop; never when unset. A restore
  // checks it before each terminal it starts and after each one it has
  // started, and starts no more once it holds.
  readonly isStopped?: () => boolean;

  // The waits before each further try at the sessions whose host refused
  // for now; three waits of 5, 15, and 45 seconds when unset, and none
  // tries no session twice.
  readonly retryDelaysMs?: readonly number[];

  // The clock behind the per-session cap and the retry delays; the wall
  // clock when unset.
  readonly clock?: Clock;
}

const RESTORE_RETRY_DELAYS_MS: readonly number[] = [5000, 15_000, 45_000];

// The longest single timer a retry delay waits on, so a stop ends the wait
// soon after.
const RETRY_SLICE_MS = 1000;

// How the staggered terminal adoption behind a restore ended: every queued
// session was tried, the daemon began to stop first, or a revive threw.
type RestoreOutcome = 'finished' | 'stopped' | 'failed';

// How one round of terminal adoption ended: the daemon began to stop, or
// every session was tried, with the session the round started last when
// it still has a terminal to wait on.
type RoundEnd =
  | { readonly stopped: true }
  | { readonly stopped: false; readonly last: Session | null };

// How many sessions a restore registered, and how its staggered terminal
// adoption ended.
export interface RestoreSettled {
  readonly restored: number;
  readonly outcome: RestoreOutcome;
}

interface RestoreFleetResult {
  // How many sessions the restore registered.
  readonly restored: number;

  // Resolves with how the staggered terminal adoption behind the restore
  // ended, at once when nothing was queued.
  readonly settled: Promise<RestoreOutcome>;
}

// The refusals a host can lift by itself, such as a remote machine that cannot take
// a lease or run a command yet, or a broker that is still starting; the
// restore tries these sessions again.
const RETRIED_ADOPT_CODES: ReadonlySet<string> = new Set(['host_unavailable', 'broker_not_ready']);

// How one try at a session's terminal ended: the session it adopted, or
// null when there was nothing to adopt, or the refusal its target gave.
type AdoptResult =
  | { readonly kind: 'adopted'; readonly session: Session | null }
  | { readonly kind: 'refused'; readonly refusal: DaemonError };

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

  // a session an earlier restore could not start a terminal for is not live until a
  // headless turn starts for it; a live session that resumed the entry's agent session
  // on another target leaves the entry to restore, as the fleet keeps a row per target
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

  // the most recently active sessions revive first, and entries that never reported an
  // event keep their stored order at the end; exited entries dedupe against every
  // listed session, so repeated restores never double up the killed archive
  const kept = stored
    .filter((entry) => (entry.exited === true ? !hasAnySession(entry) : !hasLiveSession(entry)))
    .toSorted((left, right) => findRecency(right).localeCompare(findRecency(left)));

  // Sub-sessions register after every top-level entry, so each one links
  // to a parent that is already listed; the wrangling session also boots
  // before the sessions it wrangles.
  const entries = [
    ...kept.filter((entry) => entry.parent === undefined),
    ...kept.filter((entry) => entry.parent !== undefined),
  ];

  // the whole fleet registers terminal-less up front, so the list shows every incoming
  // session at once; a row that cannot register is skipped, so one bad row never keeps
  // the rest of the fleet down
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

      // a session still listed, though dead, revives in place rather than listing twice
      const row =
        listed === undefined
          ? { session: manager.restore(resolved), revive: false }
          : { session: listed, revive: true };

      registered.push(row);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      manager.log(`atc could not restore session ${entry.sessionID} (${reason})`);
    }
  }

  // exited entries only register: they stay killed until revived by hand
  const queued = registered
    .filter((row) => row.revive || row.session.state !== 'exited')
    .map((row) => row.session);

  // A headless turn removes the unrestored mark from its session, so a
  // queued session that loses the mark without a terminal runs a turn that
  // began during this restore, and the restore starts no terminal beside it.
  const markedAtQueue = new Set(queued.filter((session) => manager.isUnrestored(session.id)));

  const hasHeadlessTurnStarted = (session: Session) =>
    markedAtQueue.has(session) && session.pty === null && !manager.isUnrestored(session.id);

  // A session that announced itself, or whose terminal died, before the
  // wait began has nothing left to wait for.
  const waitForBoot = (sessionID: SessionID): Promise<void> => {
    const runtime = findRuntime(sessionID);
    const session = manager.sessions.find((candidate) => candidate.id === sessionID);

    if (
      runtime === undefined ||
      runtime.startedAt !== null ||
      session === undefined ||
      session.pty === null
    ) {
      return Promise.resolve();
    }

    // The runtime's dispose releases the waiter, which cancels the cap.
    const settled = Promise.withResolvers<void>();
    const cancelCap = capMs > 0 ? clock.schedule(settled.resolve, capMs) : null;

    runtime.bootWaiter = settled.resolve;

    return (async () => {
      await settled.promise;

      runtime.bootWaiter = null;
      cancelCap?.();
    })();
  };

  const [first, ...rest] = queued;

  if (first === undefined) {
    return { restored: registered.length, settled: Promise.resolve('finished') };
  }

  // a failed or refused revive lists its reason without a terminal and the restore moves
  // on, so one host's failure never keeps other hosts' sessions down; a refusal the host
  // can lift by itself queues the session for another try after the next retry delay
  let failed = false;
  let retrying: Session[] = [];

  // The reason each session lists after its last refused try, so a retry
  // skips a session that something else has changed since.
  const refusals = new Map<Session, string>();

  // a session a caller stopped, revived, or forgot while the try ran keeps what the
  // caller left and gets no further try; a refusal no later try lifts lists with its
  // code, so a reader knows only an action of its own brings the session back
  const recordRefusal = (session: Session, options: RecordRefusalOptions) => {
    const listed = options.unchanged && session.pty === null && manager.sessions.includes(session);
    const retried = options.retry && listed;
    const suffix = retried ? '; trying again' : '';

    manager.log(`atc could not revive session ${session.id} (${options.reason})${suffix}`);

    if (listed) {
      const finalCode = retried ? null : options.code;

      manager.updateRestoreRefusal(session, options.reason, finalCode);
      refusals.set(session, options.reason);
    }

    if (retried) {
      retrying.push(session);
    }
  };

  const tryAdoptQueued = async (
    session: Session,
    canRetry: boolean,
    isEligible: (session: Session) => boolean,
  ): Promise<boolean> => {
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

      recordRefusal(session, { reason, code: null, retry: false, unchanged: isUnchanged() });

      return false;
    }

    if (adopted.kind === 'refused') {
      recordRefusal(session, {
        reason: formatRestoreRefusal(session.id, adopted.refusal),
        code: adopted.refusal.code,
        retry: canRetry && RETRIED_ADOPT_CODES.has(adopted.refusal.code),
        unchanged: isUnchanged(),
      });

      return false;
    }

    return adopted.session !== null;
  };

  // a daemon that stopped before a terminal started, while one started, or while the
  // previous session booted starts no more; a round returns the session it started
  // last, so the next round waits for it to boot before starting another
  const adoptEach = async (
    sessions: readonly Session[],
    previous: Session | null,
    canRetry: boolean,
    isEligible: (session: Session) => boolean,
  ): Promise<RoundEnd> => {
    let lastAdopted = previous;

    for (const session of sessions) {
      // a heavy fleet comes up one process at a time; the per-session cap keeps a
      // session that never reports its boot from stalling the rest
      if (lastAdopted !== null) {
        await waitForBoot(lastAdopted.id);
      }

      if (isStopped()) {
        return { stopped: true };
      }

      if (!isEligible(session) || hasHeadlessTurnStarted(session)) {
        lastAdopted = null;
        continue;
      }

      const booted = await tryAdoptQueued(session, canRetry, isEligible);

      if (isStopped()) {
        return { stopped: true };
      }

      lastAdopted = booted ? session : null;
    }

    return { stopped: false, last: lastAdopted };
  };

  // Waits out a retry delay a slice at a time, so a daemon that stops
  // meanwhile ends the wait within a slice; false once it has stopped.
  const waitForRetry = async (delayMs: number): Promise<boolean> => {
    const due = clock.now() + delayMs;

    while (!isStopped() && clock.now() < due) {
      await new Promise<void>((resolve) => {
        clock.schedule(resolve, Math.min(RETRY_SLICE_MS, due - clock.now()));
      });
    }

    return !isStopped();
  };

  // a retry round tries only sessions still listed under their last refusal, checked
  // before each try and while the host readies, so one a caller revived, killed, or
  // forgot meanwhile is left as it is
  const isStillRefused = (session: Session) =>
    session.pty === null &&
    manager.sessions.includes(session) &&
    session.lastMsg === refusals.get(session);

  const adoptRest = async (previous: Session | null): Promise<RestoreOutcome> => {
    let ended = await adoptEach(rest, previous, retryDelaysMs.length > 0, () => true);

    if (ended.stopped) {
      return 'stopped';
    }

    for (const [round, delayMs] of retryDelaysMs.entries()) {
      const due = retrying;

      retrying = [];

      if (due.length === 0) {
        break;
      }

      if (!(await waitForRetry(delayMs))) {
        return 'stopped';
      }

      ended = await adoptEach(due, ended.last, round + 1 < retryDelaysMs.length, isStillRefused);

      if (ended.stopped) {
        return 'stopped';
      }
    }

    return failed ? 'failed' : 'finished';
  };

  if (isStopped()) {
    return { restored: registered.length, settled: Promise.resolve('stopped') };
  }

  // the first terminal attaches before the restore answers, so a caller can attach at once
  const firstAdopted = await tryAdoptQueued(first, retryDelaysMs.length > 0, () => true);

  if (isStopped()) {
    return { restored: registered.length, settled: Promise.resolve('stopped') };
  }

  const firstBooted = firstAdopted ? first : null;

  const adoptRestLogged = async (): Promise<RestoreOutcome> => {
    try {
      return await adoptRest(firstBooted);
    } catch (error) {
      manager.log(
        `atc could not finish restoring the fleet (${error instanceof Error ? error.message : String(error)})`,
      );

      return 'failed';
    }
  };

  return { restored: registered.length, settled: adoptRestLogged() };
}

// A stored entry matches a listed session by its atc session id, or by its
// agent session id when a listed session resumed the same agent session.
function isSameSession(session: Session, entry: FleetEntry): boolean {
  return (
    session.id === entry.sessionID ||
    (entry.agentSessionID !== undefined && session.agentSessionID === entry.agentSessionID)
  );
}

// Whether a listed session runs on the target and identity a stored entry
// was bound to. An entry without a target was bound to the `local` target,
// and one without an identity matches any identity of its target.
function isOnEntryTarget(session: Session, entry: FleetEntry): boolean {
  return (
    session.target === (entry.target ?? 'local') &&
    (entry.targetIdentity === undefined || session.targetIdentity === entry.targetIdentity)
  );
}

// the refusals that leave one session without a terminal: its target is misconfigured,
// gone, changed, without a provider here, or unable to start one, its agent refuses
// every start, or its host's runtime auth binding, broker included, refuses the launch
const REFUSED_ADOPT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'unsupported_operation',
  'unknown_target',
  'target_unavailable',
  'target_changed',
  'target_config_invalid',
  'host_unavailable',
  'auth_not_configured',
  'auth_target_unsupported',
  'auth_token_scope',
  'auth_token_too_broad',
  'auth_host_out_of_scope',
  'auth_secret_not_grantable',
  'auth_secret_mismatch',
  'auth_runtime_mismatch',
  'auth_grant_missing',
  'auth_grants_mismatch',
  'auth_rebind_required',
  'auth_blocked',
  'auth_binding_invalid',
  'broker_not_ready',
  'auth_placeholder_unsupported',

  // a plugin folder the session loads is not a folder, or sits on a remote target
  'bad_args',
  'unsupported',
]);

interface TryAdoptTerminalOptions {
  readonly id: SessionID;
  readonly cols: number;
  readonly rows: number;
  readonly canProceed: () => boolean;
}

async function tryAdoptTerminal(
  manager: SessionManager,
  options: TryAdoptTerminalOptions,
): Promise<AdoptResult> {
  try {
    const session = await manager.adoptTerminal(
      options.id,
      options.cols,
      options.rows,
      options.canProceed,
    );

    return { kind: 'adopted', session };
  } catch (error) {
    if (error instanceof DaemonError && REFUSED_ADOPT_CODES.has(error.code)) {
      return { kind: 'refused', refusal: error };
    }

    throw error;
  }
}
