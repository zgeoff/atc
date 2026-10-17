import type { Clock, SessionID } from '@atc/core';
import { systemClock } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import type { FleetEntry, StateStore } from '@atc/store';
import type { Session } from '../sessions/session';
import type { SessionRuntime } from '../sessions/session-runtime';
import type { SessionManager } from '../sessions/sessions';
import { formatRestoreRefusal } from './format-restore-refusal';

interface RestoreFleetParams {
  readonly mgr: SessionManager;
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

export async function restoreFleet(params: RestoreFleetParams): Promise<RestoreFleetResult> {
  const mgr = params.mgr;
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
    mgr.sessions.some(
      (s) =>
        isSameSession(s, entry) &&
        (s.id === entry.sessionID || isOnEntryTarget(s, entry)) &&
        (s.pty !== null ||
          (s.kind === 'headless' && s.state !== 'exited' && !mgr.isUnrestored(s.id))),
    );

  const hasAnySession = (entry: FleetEntry) => mgr.sessions.some((s) => isSameSession(s, entry));

  const findRecency = (entry: FleetEntry) =>
    entry.agentSessionID === undefined ? '' : (recency.get(entry.agentSessionID) ?? '');

  const recency = await store.collectFleetRecency();
  const stored = await store.loadFleet();

  // the most recently active sessions revive first, and entries that never reported an
  // event keep their stored order at the end; exited entries dedupe against every
  // listed session, so repeated restores never double up the killed archive
  const kept = stored
    .filter((entry) => (entry.exited === true ? !hasAnySession(entry) : !hasLiveSession(entry)))
    .toSorted((a, b) => findRecency(b).localeCompare(findRecency(a)));

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
      const listed = mgr.sessions.find((s) => s.id === entry.sessionID);

      const binding =
        listed === undefined
          ? entry
          : {
              ...entry,
              target: listed.target,
              targetIdentity: listed.targetIdentity,
              hostKey: listed.hostKey,
            };

      const resolved = await mgr.resolveRestoredEntry(binding);

      if (listed !== undefined && resolved.targetIdentity !== undefined) {
        mgr.updateRestoredIdentity(listed, resolved.targetIdentity);
      }

      // a session still listed, though dead, revives in place rather than listing twice
      const row =
        listed === undefined
          ? { session: mgr.restore(resolved), revive: false }
          : { session: listed, revive: true };

      registered.push(row);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      mgr.log(`atc could not restore session ${entry.sessionID} (${reason})`);
    }
  }

  // exited entries only register: they stay killed until revived by hand
  const queued = registered
    .filter((r) => r.revive || r.session.state !== 'exited')
    .map((r) => r.session);

  // A headless turn removes the unrestored mark from its session, so a
  // queued session that loses the mark without a terminal runs a turn that
  // began during this restore, and the restore starts no terminal beside it.
  const markedAtQueue = new Set(queued.filter((s) => mgr.isUnrestored(s.id)));

  const hasHeadlessTurnStarted = (s: Session) =>
    markedAtQueue.has(s) && s.pty === null && !mgr.isUnrestored(s.id);

  // A session that announced itself, or whose terminal died, before the
  // wait began has nothing left to wait for.
  const waitForBoot = (sessionID: SessionID): Promise<void> => {
    const runtime = findRuntime(sessionID);
    const session = mgr.sessions.find((s) => s.id === sessionID);

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
  const recordRefusal = (
    s: Session,
    reason: string,
    code: string | null,
    retry: boolean,
    unchanged: boolean,
  ) => {
    const listed = unchanged && s.pty === null && mgr.sessions.includes(s);
    const retried = retry && listed;

    mgr.log(`atc could not revive session ${s.id} (${reason})${retried ? '; trying again' : ''}`);

    if (listed) {
      const finalCode = retried ? null : code;

      mgr.updateRestoreRefusal(s, reason, finalCode);
      refusals.set(s, reason);
    }

    if (retried) {
      retrying.push(s);
    }
  };

  const tryAdoptQueued = async (
    s: Session,
    canRetry: boolean,
    isEligible: (s: Session) => boolean,
  ): Promise<boolean> => {
    let adopted: AdoptResult;
    const before = { state: s.state, lastMsg: s.lastMsg };
    const isUnchanged = () => s.state === before.state && s.lastMsg === before.lastMsg;

    try {
      adopted = await tryAdoptTerminal(
        mgr,
        s.id,
        cols,
        rows,
        () => !isStopped() && isEligible(s) && !hasHeadlessTurnStarted(s),
      );
    } catch (error) {
      failed = true;

      const reason = error instanceof Error ? error.message : String(error);

      recordRefusal(s, reason, null, false, isUnchanged());

      return false;
    }

    if (adopted.kind === 'refused') {
      recordRefusal(
        s,
        formatRestoreRefusal(s.id, adopted.refusal),
        adopted.refusal.code,
        canRetry && RETRIED_ADOPT_CODES.has(adopted.refusal.code),
        isUnchanged(),
      );

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
    isEligible: (s: Session) => boolean,
  ): Promise<RoundEnd> => {
    let prev = previous;

    for (const s of sessions) {
      // a heavy fleet comes up one process at a time; the per-session cap keeps a
      // session that never reports its boot from stalling the rest
      if (prev !== null) {
        await waitForBoot(prev.id);
      }

      if (isStopped()) {
        return { stopped: true };
      }

      if (!isEligible(s) || hasHeadlessTurnStarted(s)) {
        prev = null;
        continue;
      }

      const booted = await tryAdoptQueued(s, canRetry, isEligible);

      if (isStopped()) {
        return { stopped: true };
      }

      prev = booted ? s : null;
    }

    return { stopped: false, last: prev };
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
  const isStillRefused = (s: Session) =>
    s.pty === null && mgr.sessions.includes(s) && s.lastMsg === refusals.get(s);

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
      mgr.log(
        `atc could not finish restoring the fleet (${error instanceof Error ? error.message : String(error)})`,
      );

      return 'failed';
    }
  };

  return { restored: registered.length, settled: adoptRestLogged() };
}

// A stored entry matches a listed session by its atc session id, or by its
// agent session id when a listed session resumed the same agent session.
function isSameSession(s: Session, entry: FleetEntry): boolean {
  return (
    s.id === entry.sessionID ||
    (entry.agentSessionID !== undefined && s.agentSessionID === entry.agentSessionID)
  );
}

// Whether a listed session runs on the target and identity a stored entry
// was bound to. An entry without a target was bound to the `local` target,
// and one without an identity matches any identity of its target.
function isOnEntryTarget(s: Session, entry: FleetEntry): boolean {
  return (
    s.target === (entry.target ?? 'local') &&
    (entry.targetIdentity === undefined || s.targetIdentity === entry.targetIdentity)
  );
}

// the refusals that leave one session without a terminal: its target is misconfigured,
// gone, changed, without a provider here, or unable to start one, its agent refuses
// every start, or its host's runtime auth binding, broker included, refuses the launch
const REFUSED_ADOPT_CODES: ReadonlySet<string> = new Set([
  'unsupported_operation',
  'unknown_target',
  'target_unavailable',
  'target_changed',
  'target_config_invalid',
  'host_unavailable',
  'auth_not_configured',
  'auth_target_unsupported',
  'auth_impd_too_old',
  'auth_token_scope',
  'auth_token_too_broad',
  'auth_imp_out_of_scope',
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
]);

// The refusals a host can lift by itself, such as an imp that cannot take
// a lease or run a command yet, or a broker that is still starting; the
// restore tries these sessions again.
const RETRIED_ADOPT_CODES: ReadonlySet<string> = new Set(['host_unavailable', 'broker_not_ready']);

// How one try at a session's terminal ended: the session it adopted, or
// null when there was nothing to adopt, or the refusal its target gave.
type AdoptResult =
  | { readonly kind: 'adopted'; readonly session: Session | null }
  | { readonly kind: 'refused'; readonly refusal: DaemonError };

async function tryAdoptTerminal(
  mgr: SessionManager,
  id: SessionID,
  cols: number,
  rows: number,
  canProceed: () => boolean,
): Promise<AdoptResult> {
  try {
    return { kind: 'adopted', session: await mgr.adoptTerminal(id, cols, rows, canProceed) };
  } catch (error) {
    if (error instanceof DaemonError && REFUSED_ADOPT_CODES.has(error.code)) {
      return { kind: 'refused', refusal: error };
    }

    throw error;
  }
}
