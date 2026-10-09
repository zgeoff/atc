import { DaemonError } from '../protocol/daemon-error';
import type { SessionID } from '../shared/session-id';
import { systemClock } from '../shared/system-clock';
import type { Clock } from '../shared/system-clock';
import type { FleetEntry } from '../store/fleet-entry';
import type { StateStore } from '../store/state-store';
import type { SessionRuntime } from './session-runtime';
import type { Session, SessionManager } from './sessions';

export interface RestoreFleetParams {
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

  // The clock behind the per-session cap; the wall clock when unset.
  readonly clock?: Clock;
}

// How the staggered terminal adoption behind a restore ended: every queued
// session was tried, the daemon began to stop first, or a revive threw.
type RestoreOutcome = 'finished' | 'stopped' | 'failed';

// How many sessions a restore registered, and how its staggered terminal
// adoption ended.
export interface RestoreSettled {
  readonly restored: number;
  readonly outcome: RestoreOutcome;
}

export interface RestoreFleetResult {
  // How many sessions the restore registered.
  readonly restored: number;

  // Resolves with how the staggered terminal adoption behind the restore
  // ended, at once when nothing was queued.
  readonly settled: Promise<RestoreOutcome>;
}

/**
 * Restores the fleet: dedupes stored entries against live sessions, orders
 * the rest by recency, registers every one as a terminal-less session so
 * the whole fleet lists at once, then adopts terminals one at a time,
 * waiting for each session to report it has booted before starting the
 * next.
 */
export async function restoreFleet(params: RestoreFleetParams): Promise<RestoreFleetResult> {
  const mgr = params.mgr;
  const store = params.store;
  const findRuntime = params.findRuntime;
  const cols = params.cols;
  const rows = params.rows;
  const capMs = params.capMs;
  const clock = params.clock ?? systemClock;
  const isStopped = () => params.isStopped?.() === true;

  const hasLiveSession = (entry: FleetEntry) =>
    mgr.sessions.some(
      (s) =>
        isSameSession(s, entry) &&
        (s.pty !== null || (s.kind === 'headless' && s.state !== 'exited')),
    );

  const hasAnySession = (entry: FleetEntry) => mgr.sessions.some((s) => isSameSession(s, entry));

  const findRecency = (entry: FleetEntry) =>
    entry.agentSessionID === undefined ? '' : (recency.get(entry.agentSessionID) ?? '');

  const recency = await store.collectFleetRecency();
  const stored = await store.loadFleet();

  // Most recently active sessions revive first, so the ones the user was
  // just working in come back before long-idle ones; entries that never
  // reported an event keep their stored order at the end. Exited entries
  // dedupe against every listed session, so repeated restores never double
  // up the killed archive.
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

  // The whole fleet registers as terminal-less sessions up front, so the
  // list shows every incoming session immediately instead of revealing them
  // one boot at a time. Exited entries only register — they stay killed
  // until revived by hand, so no terminal is adopted for them. An entry
  // whose session is still listed, dead, revives that session in place
  // rather than listing a second session under the same id.
  // A row that cannot be registered is logged and skipped, so one bad row
  // never keeps the rest of the fleet down.
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

  const queued = registered
    .filter((r) => r.revive || r.session.state !== 'exited')
    .map((r) => r.session);

  // A session whose target refuses to start a terminal stays listed without
  // one, and the restore moves on to the next.
  const adoptQueued = async (s: Session): Promise<boolean> => {
    const adopted = await tryAdoptTerminal(mgr, s.id, cols, rows, () => !isStopped());

    return adopted !== null;
  };

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

  // The first terminal attaches before the restore answers so a caller can
  // attach at once; each later one waits for the previous session to report it has
  // booted, so a heavy fleet comes up one process at a time instead of all
  // at once. A per-session cap keeps a session that never reports from
  // stalling the rest.
  // A session whose revive fails is logged and left without a terminal,
  // and the restore moves on: one host's failure never keeps the sessions on
  // other hosts down, and a later one's runs where nothing awaits it.
  let failed = false;

  const tryAdoptQueued = async (s: Session): Promise<boolean> => {
    try {
      return await adoptQueued(s);
    } catch (error) {
      failed = true;

      mgr.log(
        `atc could not revive session ${s.id} (${error instanceof Error ? error.message : String(error)})`,
      );

      return false;
    }
  };

  // A daemon that stopped before a terminal started, or while one started
  // or the previous session booted, starts no more terminals.
  const adoptRest = async (previous: Session | null): Promise<RestoreOutcome> => {
    let prev = previous;

    for (const s of rest) {
      if (prev !== null) {
        await waitForBoot(prev.id);
      }

      if (isStopped()) {
        return 'stopped';
      }

      const booted = await tryAdoptQueued(s);

      if (isStopped()) {
        return 'stopped';
      }

      prev = booted ? s : null;
    }

    return failed ? 'failed' : 'finished';
  };

  if (isStopped()) {
    return { restored: registered.length, settled: Promise.resolve('stopped') };
  }

  const firstAdopted = await tryAdoptQueued(first);

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

// The refusals that leave one session without a terminal: its target is
// misconfigured, gone from the config, changed, has no provider here, or
// cannot start a terminal, or its agent refuses every start, or its
// host's runtime auth binding refuses the launch, its broker included.
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

async function tryAdoptTerminal(
  mgr: SessionManager,
  id: SessionID,
  cols: number,
  rows: number,
  canProceed: () => boolean,
): Promise<Session | null> {
  try {
    return await mgr.adoptTerminal(id, cols, rows, canProceed);
  } catch (error) {
    if (error instanceof DaemonError && REFUSED_ADOPT_CODES.has(error.code)) {
      return null;
    }

    throw error;
  }
}
