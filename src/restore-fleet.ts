import type { AgentSessionID } from './agent-session-id';
import { ScreenModel } from './screen-model';
import type { SessionID } from './session-id';
import type { SessionRuntime } from './session-runtime';
import type { Session, SessionManager } from './sessions';
import type { StateStore } from './state-store';

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
}

/**
 * Restores the fleet: dedupes stored entries against live sessions, orders
 * the rest by recency, registers every one as a terminal-less session so
 * the whole fleet lists at once, then adopts terminals one at a time,
 * waiting for each session to report it has booted before starting the
 * next.
 */
export async function restoreFleet(params: RestoreFleetParams): Promise<number> {
  const mgr = params.mgr;
  const store = params.store;
  const findRuntime = params.findRuntime;
  const cols = params.cols;
  const rows = params.rows;
  const capMs = params.capMs;

  const hasLiveSession = (agentSessionID: AgentSessionID) =>
    mgr.sessions.some(
      (s) =>
        s.agentSessionID === agentSessionID &&
        (s.pty !== null || (s.kind === 'headless' && s.state !== 'exited')),
    );

  const hasAnySession = (agentSessionID: AgentSessionID) =>
    mgr.sessions.some((s) => s.agentSessionID === agentSessionID);

  const recency = await store.collectFleetRecency();
  const stored = await store.loadFleet();

  // Most recently active sessions revive first, so the ones the user was
  // just working in come back before long-idle ones; entries that never
  // reported an event keep their stored order at the end. Exited entries
  // dedupe against every listed session, so repeated restores never double
  // up the killed archive.
  const entries = stored
    .filter((entry) =>
      entry.exited === true
        ? !hasAnySession(entry.agentSessionID)
        : !hasLiveSession(entry.agentSessionID),
    )
    .toSorted((a, b) =>
      (recency.get(b.agentSessionID) ?? '').localeCompare(recency.get(a.agentSessionID) ?? ''),
    );

  // The whole fleet registers as terminal-less sessions up front, so the
  // list shows every incoming session immediately instead of revealing them
  // one boot at a time. Exited entries only register — they stay killed
  // until revived by hand, so no terminal is adopted for them.
  const registered = entries.map((entry) => mgr.restore(entry));
  const queued = registered.filter((s) => s.state !== 'exited');

  const adoptQueued = (s: Session): boolean => {
    if (mgr.adoptTerminal(s.id, cols, rows) === null) {
      return false;
    }

    const runtime = findRuntime(s.id);

    if (runtime !== undefined) {
      runtime.dims = { cols, rows };

      runtime.screen ??= new ScreenModel(cols, rows);
    }

    return true;
  };

  const waitForBoot = (sessionID: SessionID): Promise<void> => {
    const runtime = findRuntime(sessionID);

    if (runtime === undefined) {
      return Promise.resolve();
    }

    const settled = Promise.withResolvers<void>();
    const timer = capMs > 0 ? setTimeout(settled.resolve, capMs) : undefined;

    runtime.bootWaiter = settled.resolve;
    runtime.bootTimer = timer;

    return (async () => {
      await settled.promise;

      runtime.bootWaiter = null;

      if (timer !== undefined) {
        clearTimeout(timer);

        runtime.bootTimer = undefined;
      }
    })();
  };

  const [first, ...rest] = queued;

  if (first === undefined) {
    return registered.length;
  }

  // The first terminal attaches synchronously so a caller can attach at
  // once; each later one waits for the previous session to report it has
  // booted, so a heavy fleet comes up one process at a time instead of all
  // at once. A per-session cap keeps a session that never reports from
  // stalling the rest.
  const adoptRest = async (previous: Session | null) => {
    let prev = previous;

    for (const s of rest) {
      if (prev !== null) {
        await waitForBoot(prev.id);
      }

      prev = adoptQueued(s) ? s : null;
    }
  };

  const firstBooted = adoptQueued(first) ? first : null;

  void adoptRest(firstBooted);

  return registered.length;
}
