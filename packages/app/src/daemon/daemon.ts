import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HooksConfig, InvalidGitTransports, TargetConfigError } from '@atc/config';
import {
  DEFAULT_GIT_TRANSPORTS,
  LOCAL_TARGET,
  loadListenerTokens,
  parseRestoreBootTimeoutMs,
} from '@atc/config';
import { formatListenRefusal, isAllowedListenHost } from '@atc/config/host';
import type { AgentID, Clock, SessionID } from '@atc/core';
import { systemClock } from '@atc/core';
import { LocalPTYProvider } from '@atc/execution-local';
import { claimDaemonLock, findDaemonRecord, writeDaemonRecord } from '@atc/lifecycle';
import type { AgentAdapter, SourceProvider } from '@atc/plugin-api';
import { DaemonError, PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import { StateStore, buildTargetIdentity } from '@atc/store';
import type { ExecutionTarget } from './build-execution-targets';
import { buildSessionEvent } from './build-session-event';
import { buildTargetAccess } from './build-target-access';
import { createNonBlockingLog } from './create-non-blocking-log';
import type { NonBlockingLog } from './create-non-blocking-log';
import { DaemonConnection } from './daemon-connection';
import type { DaemonContext, TapClient } from './daemon-context';
import { emitInboxClosed } from './emit-inbox-closed';
import { EventSignal } from './event-signal';
import { EventTrail } from './event-trail';
import { findPeerSession } from './find-peer-session';
import { HookIntake } from './hook-intake';
import { startHookServer } from './hooks';
import { IdempotencyLedger } from './idempotency-ledger';
import { isTreeInReach } from './is-tree-in-reach';
import { makeHookRunner } from './make-hook-runner';
import type { HookScope } from './make-hook-runner';
import { MENU_TIMING } from './menu-terminal';
import type { MenuTiming } from './menu-terminal';
import { MessageBridges } from './message-bridges';
import { MessageService } from './message-service';
import { PermissionPrompts } from './permission-prompts';
import { PublishedRecords } from './published-records';
import { readPeerPID } from './read-peer-pid';
import { restoreFleet } from './restore-fleet';
import type { RestoreSettled } from './restore-fleet';
import type { SettleScheduler } from './run-eject-handoff';
import { RuntimeAuthBinder } from './runtime-auth-binder';
import { ScreenDetection } from './screen-detection';
import { ScreenModel } from './screen-model';
import type { Session } from './session';
import { SessionHandoff } from './session-handoff';
import { SessionInput } from './session-input';
import { SessionOutput } from './session-output';
import { SessionReads } from './session-reads';
import { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';
import { SpawnCatalog } from './spawn-catalog';
import { SpawnService } from './spawn-service';
import { startEventSweep } from './start-event-sweep';
import { startEventsServer } from './start-events-server';
import { startHeadlessTurn } from './start-headless-turn';
import { startTCPListener } from './start-tcp-listener';
import type { TCPListener } from './start-tcp-listener';
import { TapRegistry } from './tap-registry';
import { withOwnerOnlySocket } from './with-owner-only-socket';

export interface DaemonOptions {
  readonly socketPath: string;
  readonly reporterSocketPath: string;

  // Build string sent in the handshake and in mismatch errors, e.g. "atc/0.1.0".
  readonly build: string;
  readonly adapter?: AgentAdapter | null;

  // Adapters registered over and above the default one, each keyed by the id
  // it declares. Lookup never falls back across ids: a grok session with no
  // grok adapter is unsupported, not a Claude spawn.
  readonly adapters?: readonly AgentAdapter[];

  // The agent a spawn without one runs, reported in `agents.list`'s spawn
  // defaults; `claude` when unset.
  readonly defaultAgent?: AgentID;

  // Where sessions run, in config order; one `local` target on the local
  // pseudo-terminal provider when unset. A spawn without a target runs on
  // the default one: `local` when unset and the targets hold it, and none
  // otherwise, which refuses such a spawn.
  readonly targets?: readonly ExecutionTarget[];
  readonly defaultTarget?: string | null;

  // The target config problems the daemon started with. A target they cover
  // refuses every session, and `agents.list` returns them.
  readonly targetErrors?: readonly TargetConfigError[];

  // The targets each principal may use; unset or null when the config has
  // no principals, which leaves every principal the implicit local target.
  readonly principals?: ReadonlyMap<string, readonly string[]> | null;

  // SQLite path for daemon state; a fleet.json at legacyFleetPath seeds the
  // fleet table once so upgrading keeps the restorable fleet.
  readonly dbPath: string;
  readonly legacyFleetPath?: string;

  // When set, the daemon's pid is written here and removed on stop.
  readonly pidPath?: string;

  // When set, a read-only events socket listens here and streams every
  // broadcast event as NDJSON to any subscriber, no handshake required.
  readonly eventsSocketPath?: string;

  // User-configured hooks, keyed by wire-event name; each broadcast event
  // fires its matching commands, observational and fire-and-forget.
  readonly hooks?: HooksConfig;

  // Where the statusline contract file is written; defaults to the real one.
  readonly statusPath?: string;

  // Outbound queue capacity per client; small values force desync in tests.
  readonly queueBytes?: number;

  // How long an eject waits for the dying terminal to report SessionEnd
  // before starting the headless run anyway.
  readonly ejectSettleMs?: number;

  // Starts the eject settle timer; the daemon's clock when unset.
  readonly scheduleEjectSettle?: SettleScheduler;

  // How long a failed spawn's rollback waits for the killed process to
  // exit, once after its kill and once more after a forced kill; 2 s when
  // unset.
  readonly failedSpawnExitWaitMs?: number;

  // A fleet-wide restore revives one session at a time, waiting for each to
  // report it has booted before starting the next so the machine is not
  // buried under a dozen simultaneous agent boots. This caps how long a
  // single revive waits for that signal before moving on regardless, so a
  // session that never reports cannot stall the rest. Unset reads the same
  // setting that a restart's wait for the restored fleet reads; zero waits
  // forever, which only tests ask for.
  readonly restoreBootTimeoutMs?: number;

  // The waits before each further try at a restored session whose host
  // refused for now, such as an imp that cannot take a lease yet; the
  // restore's own delays when unset.
  readonly restoreRetryDelaysMs?: readonly number[];
  readonly tapGraceMs?: number;

  // The clock the event trail stamps each hook event with, and the clock
  // behind the tap grace window, the held-read waits, the time a note is
  // reported at, the permission request timeouts, the restore's per-session
  // boot cap and retry delays, the TCP listener's failure times, delays, and refusal
  // windows, and every other time the daemon stores; the wall clock when
  // unset.
  readonly clock?: Clock;

  // How long a menu choice waits on a session's screen; tests shorten it.
  readonly menuTiming?: MenuTiming;

  // Whether the daemon restores the stored fleet by itself once it is
  // listening, when that fleet holds sessions; off when unset.
  readonly restoreFleetOnRestart?: boolean;

  // Called once each fleet restore has ended its staggered terminal
  // adoption, with how many sessions it registered and how it ended; a
  // restore that threw before registering any reports none and failed.
  readonly onRestoreSettled?: (settled: RestoreSettled) => void;

  // Called when a start declines to restore the stored fleet by itself:
  // the option is off, or the stored fleet holds no sessions.
  readonly onRestoreSkipped?: (reason: 'disabled' | 'empty') => void;

  // Called when a Note line changes nothing: a note from a session the
  // fleet does not list, or an answer or unanswered report that matches no
  // unsettled message the reporting session owns.
  readonly onNoteIgnored?: (sessionID: string, kind: 'note' | 'answered' | 'unanswered') => void;

  // How long a confirm token from `session.forget` stays usable.
  readonly forgetConfirmMs?: number;

  // The clock confirm tokens from `session.forget` are minted and checked
  // against, in epoch milliseconds; the daemon's clock when unset.
  readonly forgetClock?: () => number;

  // The clock the event trail's sweep is scheduled on; its cutoff still
  // comes from the daemon's clock. The wall clock when unset.
  readonly eventSweepClock?: Clock;

  // Called with a session's id when it reports its start and the daemon
  // leaves the last-used agent as it is, because no spawn is waiting on
  // that start.
  readonly onLastUsedUnchanged?: (sessionID: SessionID) => void;

  // When set, a TCP listener serves the client protocol on this address to
  // peers whose handshake presents a token from the token file.
  readonly listen?: ListenOptions;

  // Called after a client-requested quit has stopped the daemon; the real
  // entrypoint exits the process, tests leave it unset.
  readonly onQuit?: () => void;

  // Where background failures are reported, one line at a time; stderr
  // when unset.
  readonly log?: (line: string) => void;

  // Called each time the daemon leaves a session's new output unjudged
  // because no screen detector covers it: no agent in the fleet has one,
  // the session's own agent has none, or the session is no longer listed.
  readonly onDetectSkipped?: (sessionID: SessionID) => void;

  // The sources the spawn picker offers, in order, each built with the
  // services it uses; none when unset.
  readonly sources?: readonly SourceProvider[];

  // The gh executable that checks a pull request a session's scope
  // declares; `gh` on PATH when unset.
  readonly ghBin?: string;

  // The transports a git workspace source may use and git may fetch over,
  // or the invalid list the config holds, which refuses every git
  // operation; https and ssh when unset.
  readonly gitTransports?: readonly string[] | InvalidGitTransports;

  // The root a git workspace without a directory lands under on any target
  // without its own, and each target's own root, by target id; the default
  // root under the target user's home when unset.
  readonly workspaceRoots?: Readonly<{
    root: string | null;
    targetRoots: ReadonlyMap<string, string>;
  }>;

  // The home a git workspace without a directory lands under on a target
  // on the daemon's own machine when no root applies; the daemon user's
  // home when unset.
  readonly homeDir?: string;
}

// The TCP listener's address and the file holding the tokens a handshake
// may present.
interface ListenOptions {
  readonly host: string;
  readonly port: number;
  readonly tokenFile: string;

  // How long a handshake waits once its source address has failed five
  // times within a minute; 10 s when unset.
  readonly failureDelayMs?: number;

  // How many delayed handshakes may wait at once across every address; 64
  // when unset.
  readonly maxDelayedHandshakes?: number;

  // How long the refusal log folds repeated refusals from one peer into one
  // line; a minute when unset.
  readonly refusalLogIntervalMs?: number;

  // How many peers and kinds of refusal the refusal log tracks at once;
  // 1024 when unset.
  readonly maxRefusalWindows?: number;
}

export interface DaemonHandle {
  // A second stop, or a disposal after one, waits on the first and stops
  // nothing again.
  readonly stop: () => Promise<void>;

  readonly [Symbol.asyncDispose]: () => Promise<void>;

  // How many client-protocol connections are open right now.
  readonly countClients: () => number;

  // How many event reads are waiting right now for the trail to grow.
  readonly countEventWaiters: () => number;

  // The port the TCP listener bound, or null without one.
  readonly listenPort: number | null;

  // Reads the token file again and closes every TCP connection whose
  // handshake token it no longer holds. A file that fails to load drops
  // every token and closes every TCP connection until a load succeeds.
  readonly refreshTokens: () => void;
}

// How long a started Claude session may go without a tap before a message to
// it is refused.
const TAP_GRACE_MS = 15_000;

// How long a confirm token from a forget that destroys a host stays usable.
const FORGET_CONFIRM_MS = 60_000;

// The principal every request on the local socket acts as.
const LOCAL_PRINCIPAL = 'local';

// A completed idempotency key is kept this long after it completed, and the
// sweep that drops older ones runs this often.
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_SWEEP_MS = 60 * 60 * 1000;

// How long a TCP handshake waits once its address has failed too often.
const HANDSHAKE_FAILURE_DELAY_MS = 10_000;

// How many delayed handshakes may wait at once; a handshake over the cap is
// refused at once.
const MAX_DELAYED_HANDSHAKES = 64;

// How long the TCP listener folds repeated refusals from one peer into one
// log line.
const REFUSAL_LOG_INTERVAL_MS = 60_000;

// How many peers and kinds of refusal the TCP listener's refusal log tracks
// at once.
const MAX_REFUSAL_WINDOWS = 1024;

// Where the TCP listener logs when the daemon is given no log.
const STDERR_FD = 2;

// How long a stopping daemon waits for the TCP listener's log to write the
// lines it still holds, so an unread stderr delays the exit no longer.
const LOG_DRAIN_TIMEOUT_MS = 1000;

// How long startup waits for a daemon that is shutting down to release the
// state lock before refusing to start.
const LOCK_WAIT_MS = 2000;

// How long a client-requested quit waits before it stops the daemon, so the
// ok response to the quit request flushes before the sockets close under it.
const QUIT_FLUSH_DELAY_MS = 80;

/**
 * The daemon: owns the sessions, the client-protocol listener, and the
 * reporter listener. Protocol requests are NDJSON lines, one response per
 * request, and state changes broadcast to every connected client. The first
 * request on a connection must be `daemon.hello`; an unknown method is an
 * error, never a disconnect; a malformed or oversized line is a disconnect,
 * because transports guarantee byte integrity and such a line means a buggy
 * or hostile peer.
 */
export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  let stopDaemon: (() => Promise<void>) | null = null;
  const clock = opts.clock ?? systemClock;

  // Set once the daemon begins to release what it holds.
  let released = false;

  // The listener's address and tokens are checked before the daemon takes
  // anything, so a refused listener leaves no state behind.
  const listenTokens = opts.listen === undefined ? null : requireListenTokens(opts.listen);

  // One daemon per state directory: the lock comes before the store, the
  // sockets, or the fleet, so a second daemon touches none of them.
  const stateDir = dirname(opts.dbPath);
  const recordPath = join(stateDir, 'daemon.json');

  const lock = await claimDaemonLock(join(stateDir, 'daemon.lock'), LOCK_WAIT_MS);

  if (lock === null) {
    const holder = findDaemonRecord(recordPath);
    const where = holder === null ? '' : ` (pid ${holder.pid}, socket ${holder.socketPath})`;

    throw Object.assign(
      new Error(`atc daemon: another daemon already serves ${stateDir}${where}`),
      { code: 'daemon_locked' },
    );
  }

  if (opts.pidPath !== undefined) {
    writeFileSync(opts.pidPath, String(process.pid));
  }

  const store = await StateStore.open(opts.dbPath, opts.legacyFleetPath);

  // Before any request is served: a workspace a stopped daemon left short
  // of ready fails as interrupted, and a key left in progress by a daemon
  // that stopped mid-effect is settled, so no retry can race either.
  await store.reconcileMaterializations(clock.now());
  await store.reconcileIdempotencyKeys(clock.now());
  await store.reconcileAuthBindings(clock.now());

  await tryRemoveExpiredIdempotencyKeys(store, clock);

  const idempotencySweep = setInterval(() => {
    void tryRemoveExpiredIdempotencyKeys(store, clock);
  }, IDEMPOTENCY_SWEEP_MS);

  idempotencySweep.unref();

  const stopEventSweep = await startEventSweep({
    store,
    clock,
    sweepClock: opts.eventSweepClock ?? systemClock,
  });

  // With no configured targets the daemon serves the local one alone,
  // which needs no atc version since no atc runs inside it.
  const targets: readonly ExecutionTarget[] = opts.targets ?? [
    {
      id: LOCAL_TARGET.id,
      kind: LOCAL_TARGET.provider,
      options: LOCAL_TARGET.options,
      identity: buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
      provider: new LocalPTYProvider(),
    },
  ];

  const targetErrors = opts.targetErrors ?? [];
  const principals = opts.principals ?? null;
  const gitTransports = opts.gitTransports ?? DEFAULT_GIT_TRANSPORTS;

  const targetsByID = new Map(targets.map((target) => [target.id, target]));

  const defaultTarget =
    opts.defaultTarget === undefined
      ? (targets.find((target) => target.id === LOCAL_TARGET.id)?.id ?? null)
      : opts.defaultTarget;

  const clients = new Set<DaemonConnection>();

  const runHooks = makeHookRunner(opts.hooks ?? {}, { clock });

  // The session the process at the other end of a local socket runs in,
  // from the pid the kernel holds for it and the harness processes of the
  // sessions that hold a live one; null outside every session, and where
  // the kernel cannot be asked.
  const findSocketSession = (socket: object): SessionID | null => {
    const pid = readPeerPID(socket);

    if (pid === null) {
      return null;
    }

    const harnesses = new Map<number, SessionID>();

    for (const session of mgr.sessions) {
      if (session.pty?.pid !== undefined) {
        harnesses.set(session.pty.pid, session.id);
      }
    }

    return findPeerSession(pid, harnesses);
  };

  // Any local process reads the events socket, a process inside a session
  // too: the socket only streams, so the session a peer runs inside binds
  // nothing on it.
  const eventsServer =
    opts.eventsSocketPath === undefined
      ? null
      : startEventsServer({
          socketPath: opts.eventsSocketPath,
          collectSnapshot: () =>
            mgr.collectDescriptors().map((session) => ({
              v: PROTOCOL_V,
              ev: 'SessionAdded',
              session,
            })),
          ...(opts.queueBytes === undefined ? {} : { queueBytes: opts.queueBytes }),
        });

  const emitEvent = (event: EventMsg, scope: HookScope | null = null) => {
    for (const client of clients) {
      client.sendEvent(event);
    }

    eventsServer?.broadcast(event);
    runHooks(event, scope);
  };

  const findHookScope = (sessionID: SessionID): HookScope | null => {
    const s = mgr.sessions.find((x) => x.id === sessionID);

    return s === undefined ? null : { cwd: s.cwd, repoRoot: s.repoRoot };
  };

  const permissions = new PermissionPrompts({ clock, emitEvent, findHookScope });
  const eventSignal = new EventSignal(clock);

  // One runtime per live session: its screen model, output sequence
  // counter, PTY dims, its resize/detect/boot timers, its live headless
  // run, and its pending eject and boot waiters. Created when the session
  // manager announces the session and disposed the moment it is removed, so
  // removal is always a single lookup plus dispose.
  const runtimes = new Map<SessionID, SessionRuntime>();

  const findRuntime = (sessionID: SessionID) => runtimes.get(sessionID);

  const taps = new TapRegistry<TapClient>();

  // The sessions whose process end the daemon saw, until a harness starts
  // for them again.
  const endedProcesses = new Set<SessionID>();

  // A spawned terminal starts on a fresh screen; a revived one keeps the
  // screen its session already had.
  const onBoot: SessionManager['onBoot'] = (s, cols, rows) => {
    endedProcesses.delete(s.id);

    const runtime = runtimes.get(s.id);

    if (runtime === undefined) {
      return;
    }

    runtime.resetBoot({ cols, rows });

    runtime.screen ??= new ScreenModel(cols, rows);

    // A bridge delivers only once its session lists and its terminal boots.
    bridges.startDelivery(s.id);
  };

  const onProcessEnded: SessionManager['onProcessEnded'] = (s) => {
    endedProcesses.add(s.id);
    void bridges.stopBridge(s.id);
    void messages.updateEndedSessionMessages(s);
  };

  const onEvent: SessionManager['onEvent'] = (kind, s) => {
    permissions.recordSessionEvent(kind, s);

    if (kind === 'removed') {
      endedProcesses.delete(s.id);
      void bridges.stopBridge(s.id);
      void messages.updateEndedSessionMessages(s);
    }

    if (kind === 'added') {
      runtimes.set(s.id, new SessionRuntime());
    }

    // A revive that dies before it ever announces itself must still release
    // the staggered restore, or a failed resume would hold up the fleet.
    if (kind === 'state' && s.pty === null) {
      runtimes.get(s.id)?.bootWaiter?.();
    }

    if (kind === 'removed') {
      output.removeSession(s.id);

      emitInboxClosed(taps.removeSession(s.id), s.id, 'removed');
      runtimes.get(s.id)?.dispose();
      runtimes.delete(s.id);
    }

    const event = buildSessionEvent(mgr, kind, s);

    if (event !== null) {
      // The scope comes from the session object rather than a descriptor
      // lookup, so dir-filtered hooks still fire for a removed session.
      emitEvent(event, { cwd: s.cwd, repoRoot: s.repoRoot });
    }
  };

  // The manager takes every callback above when it is built, so no session
  // event arrives before its handler exists.
  const mgr = new SessionManager(
    opts.adapter,
    store,
    opts.statusPath,
    opts.adapters ?? [],
    targets,
    targetErrors,
    {
      onBoot,
      onOutput: (s, data) => {
        output.recordOutput(s, data);
      },
      onProcessEnded,
      onEvent,
      onRelay: (binding, relay) => {
        hooks.startRelay(binding, relay);
      },
      startMessageBridge: (launch) => bridges.startBridge(launch),
      stopMessageBridge: (sessionID) => bridges.stopBridge(sessionID),
    },
  );

  mgr.clock = clock;

  if (opts.log !== undefined) {
    mgr.log = opts.log;
  }

  if (opts.failedSpawnExitWaitMs !== undefined) {
    mgr.failedSpawnExitWaitMs = opts.failedSpawnExitWaitMs;
  }

  const records = new PublishedRecords({
    store,
    daemonID: store.daemonID,
    localDir: join(stateDir, 'records'),
    ghBin: opts.ghBin ?? 'gh',
    now: () => clock.now(),
  });

  mgr.records = records;

  const authBinder = new RuntimeAuthBinder(store, () => clock.now());

  mgr.authBinder = authBinder;

  // Settled in the background, since it reaches impd: each binding a
  // stopped daemon left mid-change stays blocked until it is settled.
  void tryReconcileAuthBindings(authBinder, store, targetsByID, mgr.log);

  const ledger = new IdempotencyLedger(
    store,
    LOCAL_PRINCIPAL,
    (line) => {
      mgr.log(line);
    },
    clock,
  );

  const messages = new MessageService({
    mgr,
    store,
    clock,
    ledger,
    taps,
    findRuntime,
    eventSignal,
    emitEvent,
    findHookScope,
    isProcessEnded: (sessionID) => endedProcesses.has(sessionID),
    tapGraceMs: opts.tapGraceMs ?? TAP_GRACE_MS,
  });

  const hooks = new HookIntake({
    mgr,
    store,
    clock,
    messages,
    taps,
    findRuntime,
    eventSignal,
    emitEvent,
    findHookScope,
    updateBridgeThread: (sessionID, agentSessionID) => {
      bridges.updateThread(sessionID, agentSessionID);
    },
    ...(opts.onNoteIgnored === undefined ? {} : { onNoteIgnored: opts.onNoteIgnored }),
    ...(opts.onLastUsedUnchanged === undefined
      ? {}
      : { onLastUsedUnchanged: opts.onLastUsedUnchanged }),
  });

  const bridges = new MessageBridges({
    mgr,
    store,
    clock,
    messages,
    taps,
    applyNote: (e) => hooks.applyNote(e),
    stateDir,
  });

  const trail = new EventTrail({ mgr, store, clock, eventSignal });

  const detection = new ScreenDetection({
    mgr,
    clock,
    findRuntime,
    onDetectSkipped: opts.onDetectSkipped,
  });

  const output = new SessionOutput({
    mgr,
    clock,
    findRuntime,
    emitEvent,
    findHookScope,
    scheduleDetect: (sessionID) => {
      detection.scheduleDetect(sessionID);
    },
  });

  const startTurn = (sessionID: SessionID, prompt: string) =>
    startHeadlessTurn(
      mgr,
      findRuntime,
      sessionID,
      prompt,
      (turnSessionID, ev) => {
        hooks.recordHeadlessTurnEvent(turnSessionID, ev);
      },
      opts.reporterSocketPath,
    );

  const input = new SessionInput({
    mgr,
    clock,
    findRuntime,
    menuTiming: opts.menuTiming ?? MENU_TIMING,
    startHeadlessTurn: startTurn,
  });

  const handoff = new SessionHandoff({
    mgr,
    findRuntime,
    ejectSettleMs: opts.ejectSettleMs ?? 4000,
    scheduleEjectSettle: opts.scheduleEjectSettle ?? clock.schedule,
    startHeadlessTurn: startTurn,
    scheduleResize: (sessionID) => {
      output.scheduleResize(sessionID);
    },
  });

  const reads = new SessionReads({ mgr, store, records });

  const reporter = startHookServer((e) => {
    hooks.applyHookEvent(e);
  }, opts.reporterSocketPath);

  const spawns = new SpawnService({
    mgr,
    store,
    clock,
    ledger,
    findRuntime,
    gitTransports,
    defaultTarget,
    ...(opts.workspaceRoots === undefined ? {} : { workspaceRoots: opts.workspaceRoots }),
    ...(opts.homeDir === undefined ? {} : { homeDir: opts.homeDir }),
  });

  // Each confirm token a forget handed out, by token: the session it
  // forgets, when it stops being taken, and whether a forget took it. A
  // token stays known for one more lifetime after it expires, so a late
  // forget learns it expired rather than that it never existed.
  const confirmTokens = new Map<string, ConfirmToken>();

  const forgetConfirmMs = opts.forgetConfirmMs ?? FORGET_CONFIRM_MS;
  const forgetClock = opts.forgetClock ?? (() => clock.now());

  const claimConfirmToken = (sessionID: SessionID, token: string) => {
    const now = forgetClock();

    for (const [held, entry] of confirmTokens) {
      if (entry.expiresAt + forgetConfirmMs < now) {
        confirmTokens.delete(held);
      }
    }

    const entry = confirmTokens.get(token);
    let reason: 'unknown' | 'used' | 'expired' | null = null;

    if (entry === undefined || entry.session !== sessionID) {
      reason = 'unknown';
    } else if (entry.used) {
      reason = 'used';
    } else if (entry.expiresAt <= now) {
      reason = 'expired';
    }

    if (reason !== null) {
      throw new DaemonError(
        'confirm_token_invalid',
        `confirm token for session ${sessionID} is ${reason}; call session.forget without a token for a new one`,
        { reason },
      );
    }

    confirmTokens.set(token, {
      session: sessionID,
      expiresAt: entry?.expiresAt ?? now,
      used: true,
    });
  };

  // Stops the headless runs a kill or forget ended, once the manager has
  // acted: a session it removed already lost its run with its runtime, a
  // session it left exited loses it here, and a sub-session it promoted, or
  // any session of a kill or forget that failed, keeps working.
  const stopEndedHeadlessRuns = (set: readonly Session[]) => {
    for (const s of set) {
      if (s.state === 'exited') {
        runtimes.get(s.id)?.stopHeadlessRun();
      }
    }
  };

  const catalog = new SpawnCatalog({
    mgr,
    store,
    build: opts.build,
    targets,
    defaultTarget,
    targetErrors,
    ...(opts.defaultAgent === undefined ? {} : { defaultAgent: opts.defaultAgent }),
    sources: opts.sources ?? [],
    gitTransports,
  });

  // The restore in flight, from its first call until its staggered terminal
  // adoption finishes. A restore requested meanwhile joins it, so the fleet
  // never registers twice at once.
  let fleetRestore: Promise<number> | null = null;

  const runFleetRestore = (cols: number, rows: number): Promise<number> => {
    if (fleetRestore !== null) {
      return fleetRestore;
    }

    const restored = Promise.withResolvers<number>();

    fleetRestore = restored.promise;

    void (async () => {
      try {
        const result = await restoreFleet({
          mgr,
          store,
          findRuntime,
          cols,
          rows,
          capMs: opts.restoreBootTimeoutMs ?? parseRestoreBootTimeoutMs(process.env),
          ...(opts.restoreRetryDelaysMs === undefined
            ? {}
            : { retryDelaysMs: opts.restoreRetryDelaysMs }),
          isStopped: () => released,
          clock,
        });

        restored.resolve(result.restored);

        const outcome = await result.settled;

        opts.onRestoreSettled?.({ restored: result.restored, outcome });
      } catch (error) {
        restored.reject(error);
        opts.onRestoreSettled?.({ restored: 0, outcome: 'failed' });
      } finally {
        fleetRestore = null;
      }
    })();

    return restored.promise;
  };

  const ctx: DaemonContext = {
    build: opts.build,
    daemonID: store.daemonID,
    idempotencyRetentionMs: IDEMPOTENCY_TTL_MS,
    collectSessions: () => mgr.collectDescriptors(),
    collectSpawnDirs: (access) => catalog.collectSpawnDirs(access),
    collectAgents: () => catalog.collectAgents(),
    collectFleet: () => store.loadFleet(),
    loadLastUsedAgent: () => store.loadLastUsedAgent(),
    findAdapter: (kind) => mgr.findAdapter(kind),
    buildTargetAccess: (principal) => buildTargetAccess(principals, targetsByID, principal),
    hasListedPrincipal: (principal) => principals?.has(principal) ?? false,
    findSessionGrant: (id) => {
      const s = mgr.sessions.find((x) => x.id === id);

      return s === undefined ? null : { target: s.target, targetIdentity: s.targetIdentity };
    },
    findTargetIdentity: (target) => targets.find((x) => x.id === target)?.identity ?? null,
    canSeeSession: (id, access) => isTreeInReach(mgr.sessions, id, access),
    isSessionVisible: () => true,
    findPermissionSession: (request) => permissions.findSessionID(request),
    resolveSpawnParent: (id) => spawns.resolveSpawnParent(id),
    resolveSpawnTarget: (requested) => spawns.resolveSpawnTarget(requested),
    requireWorkspaceTarget: (target) => {
      spawns.requireWorkspaceTarget(target);
    },
    buildDefaultWorkspaceDir: (target, source) => spawns.buildDefaultWorkspaceDir(target, source),
    requireAgentTarget: (agent, target) => {
      spawns.requireAgentTarget(agent, target);
    },
    findSource: (id) => catalog.findSource(id),
    collectAlternateGitURLs: (url) => catalog.collectAlternateGitURLs(url),
    checkRepositoryAccess: (request) => catalog.checkRepositoryAccess(request),
    spawnSession: (plan, keyed, access) => spawns.spawnSession(plan, keyed, access),
    updateSession: (id, changes) => mgr.updateSession(id, changes),
    updateSessionScope: (id, scope) => mgr.updateScope(id, scope),
    isCallerTree: (id, caller) => mgr.isCallerTree(id, caller),
    quitDaemon: () => {
      clock.schedule(() => {
        void (async () => {
          await stopDaemon?.();

          opts.onQuit?.();
        })();
      }, QUIT_FLUSH_DELAY_MS);
    },
    killSession: async (id, stopOnly) => {
      const s = mgr.sessions.find((x) => x.id === id);

      if (s === undefined) {
        return 'missing';
      }

      for (const live of [s, ...mgr.collectChildren(id)]) {
        if (live.pty !== null) {
          mgr.requireExecution(live, mgr.pickKillCapability(live));
        }
      }

      const set = [s, ...mgr.collectChildren(id)];

      const outcome = await mgr.kill(id, stopOnly);

      stopEndedHeadlessRuns(set);

      return outcome;
    },

    // A forget on a target that cannot destroy its host forgets at once. On
    // one that can, a forget without a token checks the target and answers
    // with a token, and the forget that carries the token destroys the host.
    // A refusal the caller asks for reads the session in the same step that
    // starts the forget, so a pin or revive that lands first is seen. A pin
    // a sub-session inherits stops every caller but a session it sits under,
    // so a session can clear away its own sub-sessions; a pin of its own
    // stops that session too.
    forgetSession: async (id, confirmToken, refuse, caller) => {
      const s = mgr.sessions.find((x) => x.id === id);

      if (s === undefined) {
        return 'missing';
      }

      const owned = caller !== null && caller !== id && mgr.isCallerTree(caller, id);
      const inheritsPin = !owned && mgr.sessions.some((x) => x.id === s.parent && x.pinned);

      if (refuse.pinned && (s.pinned || inheritsPin)) {
        throw new DaemonError(
          'session_pinned',
          `session ${id} is pinned, or is a sub-session of a pinned session and the caller is not its parent; unpin it before forgetting it`,
          { session: id },
        );
      }

      if (refuse.live && (s.pty !== null || (s.kind === 'headless' && s.state !== 'exited'))) {
        throw new DaemonError(
          'session_live',
          `session ${id} is live; stop it before forgetting it`,
          { session: id },
        );
      }

      if (mgr.findProvider(s)?.capabilities.destroy === true) {
        mgr.requireExecution(s, 'destroy');

        if (confirmToken === undefined) {
          const token = randomUUID();
          const expiresAt = forgetClock() + forgetConfirmMs;

          confirmTokens.set(token, { session: id, expiresAt, used: false });

          return { confirmToken: token, expiresAt };
        }

        claimConfirmToken(id, confirmToken);
      }

      const set = [s, ...mgr.collectChildren(id)];

      const destroyed = await mgr.forget(id);

      stopEndedHeadlessRuns(set);

      return { forgotten: true, destroyed };
    },
    revokeSessionAuth: (id) => mgr.revokeAuth(id),
    updateSessionAuth: (id) => mgr.updateAuth(id),
    ejectSession: (id, prompt) => handoff.yankSession(id, prompt),
    adoptSession: (id, cols, rows, access) => handoff.adoptSession(id, cols, rows, access),
    ackSession: (id) => {
      if (!mgr.sessions.some((s) => s.id === id)) {
        return false;
      }

      mgr.ack(id);

      return true;
    },
    buildResumeCommand: (id) => mgr.buildResumeCommand(id),

    readSessionScreen: (id) => input.readSessionScreen(id),
    readSessionMenu: (id) => input.readSessionMenu(id),
    applySessionMenuChoice: (id, choice) => input.applySessionMenuChoice(id, choice),
    answerPermission: (request, decision) => permissions.answer(request, decision),
    attachSession: (client, sessionID, dims) => output.attachSession(client, sessionID, dims),
    detachSession: (client, sessionID) => {
      output.detachSession(client, sessionID);
    },
    detachClient: (client) => {
      output.detachClient(client);
    },
    writeSessionInput: (sessionID, data) => input.writeSessionInput(sessionID, data),
    writeSessionLine: (sessionID, text) => input.writeSessionLine(sessionID, text),
    resizeSession: (client, sessionID, dims) => output.updateSessionDims(client, sessionID, dims),
    resyncClient: (sessionID, client) => output.sendReplay(sessionID, client),
    ...(opts.queueBytes === undefined ? {} : { queueBytes: opts.queueBytes }),
    getEffectiveDims: (sessionID) => output.getEffectiveDims(sessionID),
    restoreFleet: runFleetRestore,
    writeStateBackup: (path) => store.writeBackup(path),
    readSessionRecord: (id, access) => reads.readSessionRecord(id, access),
    loadSessionTranscript: (id, from, limit) => reads.loadSessionTranscript(id, from, limit),
    readEvents: (afterID, limit, waitMs, sessionID, access) =>
      trail.readEvents(afterID, limit, waitMs, sessionID, access),
    readNote: (id, access) => trail.readNote(id, access),
    readAnswer: (id, access) => trail.readAnswer(id, access),
    writeSessionMessage: (sessionID, caller, text, keyed, access, callerSession) =>
      messages.writeSessionMessage(sessionID, caller, text, keyed, access, callerSession),
    attachTap: (client, sessionID, access, notices) =>
      messages.attachTap(client, sessionID, access, notices),
    detachTap: (client, sessionID) => {
      messages.detachTap(client, sessionID);
    },
    readMessage: (messageID, waitMs) => messages.readMessage(messageID, waitMs),
    ackMessage: (client, sessionID, messageID, access) =>
      messages.ackMessage(client, sessionID, messageID, access),
    ackNotice: (client, sessionID, messageID) => messages.ackNotice(client, sessionID, messageID),
  };

  // Releases everything the daemon holds except its listeners, on a stop
  // and on a start that fails once it holds the lock.
  const releaseResources = async () => {
    released = true;

    clearInterval(idempotencySweep);
    stopEventSweep();
    eventsServer?.stop();
    reporter.stop(true);
    mgr.detachAll();

    await Promise.all(
      targets.flatMap((target) => {
        const disposed = target.provider?.dispose();

        return disposed instanceof Promise ? [disposed] : [];
      }),
    );

    for (const runtime of runtimes.values()) {
      runtime.dispose();
    }

    runtimes.clear();

    await bridges.stopAll();

    eventSignal.dispose();

    await store.stop();

    try {
      unlinkSync(recordPath);
    } catch {}

    if (opts.pidPath !== undefined) {
      try {
        unlinkSync(opts.pidPath);
      } catch {}
    }

    lock.dispose();
  };

  const detachConnection = (connection: DaemonConnection) => {
    clients.delete(connection);
    ctx.detachClient(connection);
    taps.detachAll(connection);
  };

  // The TCP listener binds before the unix socket, so a bind that fails
  // refuses the start before any client can connect, and releases what the
  // daemon holds, the lock included.
  let tcpListener: TCPListener | null = null;
  let listenerLog: NonBlockingLog | null = null;

  if (opts.listen !== undefined && listenTokens !== null) {
    // A given log writes as it is called, so it has nothing to drain.
    listenerLog =
      opts.log === undefined
        ? createNonBlockingLog(STDERR_FD, clock)
        : { log: opts.log, drain: () => Promise.resolve() };

    try {
      tcpListener = startTCPListener({
        host: opts.listen.host,
        port: opts.listen.port,
        tokens: listenTokens,
        failureDelayMs: opts.listen.failureDelayMs ?? HANDSHAKE_FAILURE_DELAY_MS,
        maxDelayedHandshakes: opts.listen.maxDelayedHandshakes ?? MAX_DELAYED_HANDSHAKES,
        openConnection: (socket, peer) => {
          const connection = new DaemonConnection(socket, ctx, peer);

          clients.add(connection);

          return connection;
        },
        closeConnection: detachConnection,
        log: listenerLog.log,
        refusalLogIntervalMs: opts.listen.refusalLogIntervalMs ?? REFUSAL_LOG_INTERVAL_MS,
        maxRefusalWindows: opts.listen.maxRefusalWindows ?? MAX_REFUSAL_WINDOWS,
        clock,
      });
    } catch (error) {
      await releaseResources();

      throw buildBindRefusal(opts.listen, error);
    }
  }

  try {
    unlinkSync(opts.socketPath);
  } catch {}

  const server = withOwnerOnlySocket(opts.socketPath, () =>
    Bun.listen<DaemonConnection>({
      unix: opts.socketPath,
      socket: {
        open(socket) {
          socket.data = new DaemonConnection(socket, ctx, null, findSocketSession(socket));

          clients.add(socket.data);
        },
        data(socket, buf) {
          socket.data.applyChunk(socket.data.decodeChunk(buf));
        },
        drain(socket) {
          socket.data.drain();
        },
        close(socket) {
          detachConnection(socket.data);
        },
        error() {},
      },
    }),
  );

  const refreshTokens = () => {
    if (opts.listen === undefined || tcpListener === null) {
      return;
    }

    const loaded = loadListenerTokens(opts.listen.tokenFile);

    if (loaded.ok) {
      tcpListener.setTokens(loaded.tokens);

      return;
    }

    tcpListener.setTokens(null);

    mgr.log(
      `atc daemon: token reload failed (${loaded.reason}); every TCP connection is closed and refused until a reload succeeds`,
    );
  };

  // The stop under way or done, which a quit, a second stop, and a disposal
  // all wait on instead of releasing anything twice; a stop that fails is
  // forgotten, so the next one retries the release.
  let stopping: Promise<void> | null = null;

  stopDaemon = async () => {
    stopping ??= (async () => {
      // Ends each client itself so every peer sees the close: a stopped
      // listener does not reliably end the connections it already accepted.
      for (const client of clients) {
        client.dispose();
      }

      tcpListener?.stop();
      server.stop(true);

      await releaseResources();

      // The stopped listener logs no more lines, so this writes the ones the
      // log still holds, waiting no longer than the timeout when nothing
      // reads stderr.
      await listenerLog?.drain(LOG_DRAIN_TIMEOUT_MS);
    })();

    const current = stopping;

    try {
      await current;
    } catch (error) {
      if (stopping === current) {
        stopping = null;
      }

      throw error;
    }
  };

  writeDaemonRecord(recordPath, {
    pid: process.pid,
    socketPath: opts.socketPath,
    reporterSocketPath: opts.reporterSocketPath,
    eventsSocketPath: opts.eventsSocketPath ?? null,
    listenPort: tcpListener?.port ?? null,
  });

  // The stored fleet restores once per start, at the size a restored
  // terminal takes until its first attach resizes it. A failure is logged
  // and never stops the daemon.
  const tryRunFleetRestore = async (): Promise<void> => {
    try {
      await runFleetRestore(80, 24);
    } catch (error) {
      mgr.log(
        `atc could not restore the fleet (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  };

  // Every harness on the daemon's own machine ended with the daemon before
  // this one, so the messages its sessions held delivered get no answer. A
  // row whose agent session id a live row on a remote target holds marks
  // only its own messages: that session may still run there.
  try {
    const fleet = await store.loadFleet();

    for (const entry of fleet) {
      const shared = fleet.some(
        (x) =>
          x.sessionID !== entry.sessionID &&
          x.agentSessionID !== undefined &&
          x.agentSessionID === entry.agentSessionID &&
          x.exited !== true &&
          !mgr.isLocalTarget(x.target ?? LOCAL_TARGET.id),
      );

      if (mgr.isLocalTarget(entry.target ?? LOCAL_TARGET.id)) {
        await messages.updateEndedMessages(entry.sessionID, {
          atcID: entry.sessionID,
          ...(entry.agentSessionID === undefined || shared
            ? {}
            : { agentSessionID: entry.agentSessionID }),
        });
      }
    }
  } catch {}

  if (opts.restoreFleetOnRestart === true) {
    const stored = await store.loadFleet();

    if (stored.length > 0) {
      void tryRunFleetRestore();
    } else {
      opts.onRestoreSkipped?.('empty');
    }
  } else {
    opts.onRestoreSkipped?.('disabled');
  }

  return {
    stop: stopDaemon,
    [Symbol.asyncDispose]: stopDaemon,
    countClients: () => clients.size,
    countEventWaiters: () => eventSignal.countWaiters(),
    listenPort: tcpListener?.port ?? null,
    refreshTokens,
  };
}

// The tokens the TCP listener starts with. Throws, with the code a refused
// start carries, for an address outside the allowed ranges or a token file
// that fails to load, so the daemon never starts with a listener that
// takes no token or binds where it must not.
function requireListenTokens(listen: ListenOptions): readonly string[] {
  if (!isAllowedListenHost(listen.host)) {
    throw Object.assign(new Error(`atc daemon: ${formatListenRefusal(listen.host)}`), {
      code: 'listen_refused',
    });
  }

  const loaded = loadListenerTokens(listen.tokenFile);

  if (!loaded.ok) {
    throw Object.assign(new Error(`atc daemon: --token-file: ${loaded.reason}`), {
      code: 'listen_refused',
    });
  }

  return loaded.tokens;
}

// The refused start for a TCP listener whose bind failed, holding the
// address and the bind error's code, such as EADDRINUSE for a port another
// socket holds.
function buildBindRefusal(listen: ListenOptions, error: unknown): Error {
  const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : null;

  const address = listen.host.includes(':')
    ? `[${listen.host}]:${listen.port}`
    : `${listen.host}:${listen.port}`;

  const reason = typeof code === 'string' ? code : String(error);

  return Object.assign(new Error(`atc daemon: --listen cannot bind ${address} (${reason})`), {
    code: 'listen_refused',
  });
}

// A sweep that fails leaves the keys for the next one.
async function tryRemoveExpiredIdempotencyKeys(store: StateStore, clock: Clock): Promise<boolean> {
  try {
    await store.removeExpiredIdempotencyKeys(clock.now() - IDEMPOTENCY_TTL_MS);
  } catch {
    return false;
  }

  return true;
}

// Settles the runtime auth bindings a stopped daemon left mid-change, each
// through its target's broker; a host with a fleet entry is listed, and a
// failure is logged and leaves its binding blocked.
async function tryReconcileAuthBindings(
  binder: RuntimeAuthBinder,
  store: StateStore,
  targets: ReadonlyMap<string, ExecutionTarget>,
  log: (line: string) => void,
): Promise<boolean> {
  try {
    const fleet = await store.loadFleet();

    const listed = new Set(fleet.map((entry) => entry.hostKey ?? entry.sessionID));

    await binder.reconcileBindings(
      (target) => targets.get(target)?.provider?.brokerAuth ?? null,
      listed,
      log,
    );
  } catch (error) {
    log(
      `atc could not settle runtime auth bindings (${error instanceof Error ? error.message : String(error)})`,
    );

    return false;
  }

  return true;
}

interface ConfirmToken {
  readonly session: SessionID;
  readonly expiresAt: number;
  readonly used: boolean;
}
