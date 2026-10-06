import { DaemonError } from '../protocol/daemon-error';
import type { SessionID } from '../shared/session-id';
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

  // Whether a session spawned without its own choice gets one message to
  // carry on a turn the previous daemon's stop cut off, and how that
  // message is sent once the session's terminal is adopted.
  readonly resumeInterruptedTurns: boolean;
  readonly sendResumeMessage: (s: Session) => Promise<void>;
}

/**
 * Restores the fleet: dedupes stored entries against live sessions, orders
 * the rest by recency, registers every one as a terminal-less session so
 * the whole fleet lists at once, then adopts terminals one at a time,
 * waiting for each session to report it has booted before starting the
 * next. A session that was mid-turn when the previous daemon stopped, and
 * that resumes interrupted turns, gets one message to carry on once its
 * terminal is adopted.
 */
export async function restoreFleet(params: RestoreFleetParams): Promise<number> {
  const mgr = params.mgr;
  const store = params.store;
  const findRuntime = params.findRuntime;
  const cols = params.cols;
  const rows = params.rows;
  const capMs = params.capMs;
  const sendResumeMessage = params.sendResumeMessage;

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
  const registered = entries.map((entry) => {
    const listed = mgr.sessions.find((s) => s.id === entry.sessionID);

    return listed === undefined
      ? { session: mgr.restore(entry), revive: false }
      : { session: listed, revive: true };
  });

  const queued = registered
    .filter((r) => r.revive || r.session.state !== 'exited')
    .map((r) => r.session);

  // Only a session this restore registers comes from the previous daemon's
  // fleet; a listed one this daemon already ran is revived by hand. The
  // trail is read before any terminal is adopted, since a revived agent's
  // own events move it on.
  const interrupted = await collectInterruptedTurns(
    mgr,
    store,
    registered.filter((r) => !r.revive && r.session.state !== 'exited').map((r) => r.session),
    params.resumeInterruptedTurns,
  );

  // A session whose target refuses to start a terminal stays listed without
  // one, and the restore moves on to the next. A resume message that fails
  // to send is logged, and the session runs on without it.
  const adoptQueued = async (s: Session): Promise<boolean> => {
    const adopted = await tryAdoptTerminal(mgr, s.id, cols, rows);

    if (adopted !== null && interrupted.has(s.id)) {
      try {
        await sendResumeMessage(s);
      } catch (error) {
        mgr.log(
          `atc could not send session ${s.id} its resume message (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }

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

  // The first terminal attaches before the restore answers so a caller can
  // attach at once; each later one waits for the previous session to report it has
  // booted, so a heavy fleet comes up one process at a time instead of all
  // at once. A per-session cap keeps a session that never reports from
  // stalling the rest.
  // A session whose revive fails is logged and left without a terminal,
  // and the restore moves on: one host's failure never keeps the sessions on
  // other hosts down, and a later one's runs where nothing awaits it.
  const tryAdoptQueued = async (s: Session): Promise<boolean> => {
    try {
      return await adoptQueued(s);
    } catch (error) {
      mgr.log(
        `atc could not revive session ${s.id} (${error instanceof Error ? error.message : String(error)})`,
      );

      return false;
    }
  };

  const adoptRest = async (previous: Session | null) => {
    let prev = previous;

    for (const s of rest) {
      if (prev !== null) {
        await waitForBoot(prev.id);
      }

      const booted = await tryAdoptQueued(s);

      prev = booted ? s : null;
    }
  };

  const firstAdopted = await tryAdoptQueued(first);

  const firstBooted = firstAdopted ? first : null;

  void adoptRest(firstBooted);

  return registered.length;
}

// The sessions whose last turn event in the trail is a submitted prompt:
// the previous daemon stopped while their turn ran. A session's own choice
// beats the config, and an agent that takes no atc messages has no path for
// the resume message. Only a harness on the daemon's own machine ends with
// the daemon; one on a host with a lifecycle of its own runs on, so its
// turn was never cut off and a revive attaches to it as it stands.
async function collectInterruptedTurns(
  mgr: SessionManager,
  store: StateStore,
  sessions: readonly Session[],
  configured: boolean,
): Promise<ReadonlySet<SessionID>> {
  const interrupted = new Set<SessionID>();

  for (const s of sessions) {
    if (
      !(s.resumeInterruptedTurns ?? configured) ||
      s.attachment !== 'local' ||
      mgr.findAdapter(s.agent)?.takesMessages !== true
    ) {
      continue;
    }

    const kind = await store.findLatestTurnKind(s.id, s.agentSessionID);

    if (kind === 'prompt-submitted') {
      interrupted.add(s.id);
    }
  }

  return interrupted;
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
): Promise<Session | null> {
  try {
    return await mgr.adoptTerminal(id, cols, rows);
  } catch (error) {
    if (error instanceof DaemonError && REFUSED_ADOPT_CODES.has(error.code)) {
      return null;
    }

    throw error;
  }
}
