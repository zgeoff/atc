import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { planTypedLineInput } from '../agents/plan-typed-line-input';
import type { AdapterEvent } from '../protocol/adapter-event';
import { DaemonError } from '../protocol/daemon-error';
import type { HookEvent } from '../protocol/hook-event';
import { MAX_CHUNK, PROTOCOL_V } from '../protocol/protocol';
import type { EventMsg } from '../protocol/protocol';
import type { SpawnWorkspaceSource } from '../protocol/request-param-schemas';
import type { SessionState } from '../protocol/session-state';
import type { HooksConfig } from '../shared/collect-hooks';
import type { TargetConfigError } from '../shared/collect-targets';
import type { InvalidGitTransports } from '../shared/collect-workspaces-config';
import { DEFAULT_GIT_TRANSPORTS } from '../shared/default-git-transports';
import { findDaemonRecord } from '../shared/find-daemon-record';
import type { MessageID } from '../shared/message-id';
import { isRecord } from '../shared/report';
import { resolveHomeDir } from '../shared/resolve-home-dir';
import type { SessionID } from '../shared/session-id';
import { toMessageID } from '../shared/to-message-id';
import { truncateToBytes } from '../shared/truncate-to-bytes';
import type { SourceProvider } from '../sources/types';
import type { IdempotencyRecord } from '../store/idempotency-record';
import type { MessageOwner } from '../store/message-owner';
import type { MessageRecord, MessageStatus } from '../store/message-record';
import { StateStore } from '../store/state-store';
import type { EventScope } from '../store/state-store';
import type { TrailEntry } from '../store/trail-entry';
import type { SessionWorkspace } from '../store/workspace-materialization';
import { checkRepositoryAccess } from '../workspace/check-repository-access';
import { ANSWER_BYTE_CAP } from './answer-byte-cap';
import { AttachRegistry } from './attach-registry';
import { buildAgentList } from './build-agent-list';
import { buildConfigRevision } from './build-config-revision';
import { buildDefaultWorkspaceDir } from './build-default-workspace-dir';
import { buildExecutionTargets } from './build-execution-targets';
import type { ExecutionTarget } from './build-execution-targets';
import { buildFleetEvents } from './build-fleet-events';
import { buildGrantFromFleetEntry } from './build-grant-from-fleet-entry';
import { buildMessageTrailEntry } from './build-message-trail-entry';
import { buildReportTrailEntry } from './build-report-trail-entry';
import { buildReportView } from './build-report-view';
import { buildSessionEvent } from './build-session-event';
import { buildSessionMessageEvent } from './build-session-message-event';
import { buildSessionReportEvent } from './build-session-report-event';
import { buildTargetAccess } from './build-target-access';
import { buildTargetForbiddenError } from './build-target-forbidden-error';
import { buildTargetList } from './build-target-list';
import { claimDaemonLock } from './claim-daemon-lock';
import { createNonBlockingLog } from './create-non-blocking-log';
import type { NonBlockingLog } from './create-non-blocking-log';
import { DaemonConnection } from './daemon-connection';
import type {
  DaemonContext,
  MessageRefusal,
  OutputClient,
  SpawnParams,
  TapClient,
} from './daemon-context';
import { drainInbox } from './drain-inbox';
import type { InboxSource } from './drain-inbox';
import { EffectRemainsError } from './effect-remains-error';
import { EventSignal } from './event-signal';
import { startHookServer } from './hooks';
import { IdempotencyLedger } from './idempotency-ledger';
import { isAllowedListenHost } from './is-allowed-listen-host';
import { isOwnHookEvent } from './is-own-hook-event';
import { isTreeInReach } from './is-tree-in-reach';
import { loadListenerTokens } from './load-listener-tokens';
import { loadTranscriptPage } from './load-transcript-page';
import { makeHookRunner } from './make-hook-runner';
import type { HookScope } from './make-hook-runner';
import { materializeWorkspace } from './materialize-workspace';
import { mintMessageID } from './mint-message-id';
import { mintSessionID } from './mint-session-id';
import { parseReport } from './parse-report';
import { PermissionRegistry } from './permission-registry';
import { requireGitTransports } from './require-git-transports';
import { restoreFleet } from './restore-fleet';
import { runEjectHandoff } from './run-eject-handoff';
import { RuntimeAuthBinder } from './runtime-auth-binder';
import { ScreenModel } from './screen-model';
import { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';
import type { Session, SessionDescriptor } from './sessions';
import { startEventsServer } from './start-events-server';
import { startHeadlessTurn } from './start-headless-turn';
import { startSessionBridge } from './start-session-bridge';
import { startTCPListener } from './start-tcp-listener';
import type { TCPListener } from './start-tcp-listener';
import { TapRegistry } from './tap-registry';
import type { TargetAccess } from './target-access';
import { writeDaemonRecord } from './write-daemon-record';

export interface DaemonOptions {
  readonly socketPath: string;
  readonly reporterSocketPath: string;

  // Build string sent in the handshake and in mismatch errors, e.g. "atc/0.1.0".
  readonly build: string;
  readonly adapter: AgentAdapter;

  // Adapters registered over and above the default one, each keyed by the id
  // it declares. Lookup never falls back across ids: a grok session with no
  // grok adapter is unsupported, not a Claude spawn.
  readonly adapters?: readonly AgentAdapter[];

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

  // A fleet-wide restore revives one session at a time, waiting for each to
  // report it has booted before starting the next so the machine is not
  // buried under a dozen simultaneous agent boots. This caps how long a
  // single revive waits for that signal before moving on regardless, so a
  // session that never reports cannot stall the rest. Zero waits forever.
  readonly restoreBootTimeoutMs?: number;
  readonly tapGraceMs?: number;

  // Whether a fleet restore sends a session that was mid-turn when the
  // previous daemon stopped one message to carry on, for a session spawned
  // without its own choice; off when unset.
  readonly resumeInterruptedTurns?: boolean;

  // How long a confirm token from `session.forget` stays usable.
  readonly forgetConfirmMs?: number;

  // When set, a TCP listener serves the client protocol on this address to
  // peers whose handshake presents a token from the token file.
  readonly listen?: ListenOptions;

  // Called after a client-requested quit has stopped the daemon; the real
  // entrypoint exits the process, tests leave it unset.
  readonly onQuit?: () => void;

  // Where background failures are reported, one line at a time; stderr
  // when unset.
  readonly log?: (line: string) => void;

  // The sources the spawn picker offers, in order, each built with the
  // services it uses; none when unset.
  readonly sources?: readonly SourceProvider[];

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

  // The clock the refusal log reads, Date.now when unset, and how long it
  // folds repeated refusals from one peer into one line; a minute when
  // unset.
  readonly now?: () => number;
  readonly refusalLogIntervalMs?: number;

  // How many peers and kinds of refusal the refusal log tracks at once;
  // 1024 when unset.
  readonly maxRefusalWindows?: number;
}

export interface DaemonHandle {
  readonly stop: () => Promise<void>;

  // How many client-protocol connections are open right now.
  readonly countClients: () => number;

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

/**
 * The daemon: owns the sessions, the client-protocol listener, and the
 * reporter listener. Protocol requests are NDJSON lines, one response per
 * request, and state changes broadcast to every connected client. The first
 * request on a connection must be `daemon.hello`; an unknown method is an
 * error, never a disconnect; a malformed or oversized line is a disconnect,
 * because transports guarantee byte integrity and such a line means a buggy
 * or hostile peer.
 */
// The sender and opening of the message a restore sends a session whose
// turn the previous daemon's stop cut off.
const RESUME_SENDER = 'atc';
const RESUME_LEAD = 'atc restarted the daemon';

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  let stopDaemon: (() => Promise<void>) | null = null;

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
  await store.reconcileMaterializations(Date.now());
  await store.reconcileIdempotencyKeys(Date.now());
  await store.reconcileAuthBindings(Date.now());

  await tryRemoveExpiredIdempotencyKeys(store);

  const idempotencySweep = setInterval(() => {
    void tryRemoveExpiredIdempotencyKeys(store);
  }, IDEMPOTENCY_SWEEP_MS);

  idempotencySweep.unref();

  const targets =
    opts.targets ??
    buildExecutionTargets([{ id: 'local', provider: 'local-pty', options: {} }]).targets;

  const targetErrors = opts.targetErrors ?? [];
  const principals = opts.principals ?? null;
  const gitTransports = opts.gitTransports ?? DEFAULT_GIT_TRANSPORTS;

  const targetsByID = new Map(targets.map((target) => [target.id, target]));

  const defaultTarget =
    opts.defaultTarget === undefined
      ? (targets.find((target) => target.id === 'local')?.id ?? null)
      : opts.defaultTarget;

  const configRevision = buildConfigRevision(targets, defaultTarget, targetErrors);

  const mgr = new SessionManager(
    opts.adapter,
    store,
    opts.statusPath,
    opts.adapters ?? [],
    targets,
    targetErrors,
  );

  if (opts.log !== undefined) {
    mgr.log = opts.log;
  }

  const authBinder = new RuntimeAuthBinder(store);

  mgr.authBinder = authBinder;

  // Settled in the background, since it reaches impd: each binding a
  // stopped daemon left mid-change stays blocked until it is settled.
  void tryReconcileAuthBindings(authBinder, store, targetsByID, mgr.log);

  const clients = new Set<DaemonConnection>();

  const runHooks = makeHookRunner(opts.hooks ?? {});

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

  const registry = new PermissionRegistry();
  const eventSignal = new EventSignal();

  // A trail write that fails never fails the message request or report behind it.
  // Returns false when the entry was not written: a failed write, or a
  // report the trail already holds.
  const recordTrailEntry = async (entry: TrailEntry): Promise<boolean> => {
    let written: boolean;

    try {
      written = await store.recordTrailEntry(entry);
    } catch {
      return false;
    }

    if (written) {
      eventSignal.emit();
    }

    return written;
  };

  // Notes a message status change in the trail before broadcasting it, so a
  // client reading the trail on the broadcast finds the change already there.
  const recordMessageStatus = async (sessionID: SessionID, record: MessageRecord) => {
    const s = mgr.sessions.find((x) => x.id === sessionID);

    await recordTrailEntry(buildMessageTrailEntry(sessionID, s?.agentSessionID, record));

    emitEvent(buildSessionMessageEvent(sessionID, record), findHookScope(sessionID));
  };

  // A live session's scope also matches the rows it wrote under an earlier
  // atc id, through the agent session id a restore carries on. Under an
  // access, the scope holds only the atc ids of the sessions whose whole
  // tree is on targets the access holds, so a session outside it matches
  // nothing, as a session never seen does. It holds no agent session id there: a session on
  // another target can resume the same agent session, and its rows would
  // match.
  const buildEventScope = (
    sessionID: SessionID | null,
    access: TargetAccess | null,
  ): EventScope | null => {
    if (access === null) {
      if (sessionID === null) {
        return null;
      }

      const agentSessionID = mgr.sessions.find((x) => x.id === sessionID)?.agentSessionID;

      return {
        atcIDs: [sessionID],
        agentSessionIDs: agentSessionID === undefined ? [] : [agentSessionID],
      };
    }

    const visible = mgr.sessions.filter(
      (x) =>
        (sessionID === null || x.id === sessionID) && isTreeInReach(mgr.sessions, x.id, access),
    );

    return { atcIDs: visible.map((x) => x.id), agentSessionIDs: [] };
  };

  // The sessions that may name a trail row: under an access, only those
  // whose whole tree is on targets it holds.
  const collectNamingDescriptors = (access: TargetAccess | null): SessionDescriptor[] => {
    const reached = new Set(
      mgr.sessions
        .filter((x) => access === null || isTreeInReach(mgr.sessions, x.id, access))
        .map((x) => x.id),
    );

    return mgr.collectDescriptors().filter((d) => reached.has(d.id));
  };

  // A message belongs to the live session holding its atc id, else to the
  // one holding its agent session id, else to the atc id it was sent to.
  const readMessageView = async (messageID: MessageID) => {
    const record = await store.findMessageByID(messageID);

    if (record === null) {
      return null;
    }

    const owner =
      mgr.sessions.find((x) => x.id === record.atcID) ??
      mgr.sessions.find(
        (x) => record.agentSessionID !== undefined && x.agentSessionID === record.agentSessionID,
      );

    return {
      session: owner?.id ?? record.atcID,
      record,
      answeredWith: await store.collectTurnSiblings(record),
    };
  };

  registry.onRequested = (req) => {
    emitEvent(
      {
        v: PROTOCOL_V,
        ev: 'PermissionRequested',
        request: req.id,
        s: req.sessionID,
        message: req.message,
        respondable: req.respondable,
      },
      findHookScope(req.sessionID),
    );
  };

  registry.onResolved = (id, decision) => {
    emitEvent({ v: PROTOCOL_V, ev: 'PermissionResolved', request: id, decision });
  };

  // One runtime per live session: its screen model, output sequence
  // counter, PTY dims, its resize/detect/boot timers, its live headless
  // run, and its pending eject and boot waiters. Created when the session
  // manager announces the session and disposed the moment it is removed, so
  // removal is always a single lookup plus dispose.
  const runtimes = new Map<SessionID, SessionRuntime>();

  const findRuntime = (sessionID: SessionID) => runtimes.get(sessionID);

  const attachments = new AttachRegistry<OutputClient>();
  const taps = new TapRegistry<TapClient>();

  // Writes accepted messages one at a time so the store's insertion order is
  // the order of their sent times, which the inbox drains by.
  let lastMessageWrite: Promise<void> = Promise.resolve();

  const inboxSource: InboxSource = {
    taps,
    findLinkedOwner: (sessionID) => {
      const s = mgr.sessions.find((x) => x.id === sessionID);

      return s === undefined ? null : buildMessageOwner(s);
    },
    collectPendingMessages: (owner) => store.collectPendingMessages(owner),
  };

  const drainSessionInbox = (sessionID: SessionID) => drainInbox(sessionID, inboxSource);

  // A report id, which a remote session's reporter gives each report,
  // makes a resent note land once; a resent answer changes nothing, since
  // only an unanswered message takes one.
  const applyReport = async (e: HookEvent, reportID?: string) => {
    const report = parseReport(e.payload);

    if (report === null) {
      return;
    }

    if (report.kind === 'note') {
      const sender = mgr.sessions.find((x) => x.id === e.atcId);

      if (sender !== undefined) {
        const capped = { ...report, text: truncateToBytes(report.text, ANSWER_BYTE_CAP) };
        const reportedAt = Date.now();

        const entry = buildReportTrailEntry(
          sender.id,
          sender.agentSessionID,
          capped,
          reportedAt,
          reportID,
        );

        const written = await recordTrailEntry(entry);

        if (written) {
          emitEvent(
            buildSessionReportEvent(sender.id, capped, reportedAt),
            findHookScope(sender.id),
          );
        }
      }

      return;
    }

    const s = mgr.sessions.find((x) => x.id === e.atcId);
    const owner = s === undefined ? { atcID: e.atcId } : buildMessageOwner(s);

    try {
      // One statement answers the whole turn, so a reader that sees any
      // member answered already finds every sibling answered beside it.
      const answered = await store.updateMessagesAnswered(
        report.messages,
        owner,
        truncateToBytes(report.answer, ANSWER_BYTE_CAP),
        Date.now(),
        report.turn,
      );

      for (const record of answered) {
        await recordMessageStatus(e.atcId, record);
      }
    } catch {}
  };

  // The screen tier of the detector stack: once a session's output has
  // quiesced, judge the serialized screen and flip running/needs_you.
  const scheduleDetect = (sessionID: SessionID) => {
    if (!mgr.hasScreenDetector) {
      return;
    }

    const s = mgr.sessions.find((x) => x.id === sessionID);
    const detector = s === undefined ? null : (mgr.findAdapter(s.agent)?.screenDetector ?? null);
    const runtime = runtimes.get(sessionID);

    if (detector === null || runtime === undefined) {
      return;
    }

    clearTimeout(runtime.detectTimer);

    runtime.detectTimer = setTimeout(() => {
      runtime.detectTimer = undefined;
      void applyScreenJudgment(sessionID);
    }, 300);
  };

  // Replay is the serialized screen sent as ordinary output events: the
  // client cannot tell replay from live and does not need to. A clear leads
  // so a stale or desynced client screen resets first.
  const sendReplay = async (sessionID: SessionID, client: OutputClient) => {
    const runtime = runtimes.get(sessionID);

    if (runtime === undefined || runtime.screen === null) {
      return;
    }

    const replay = `\u001B[2J\u001B[H${await runtime.screen.renderReplay()}`;
    const seq = runtime.seq;

    for (let i = 0; i < replay.length; i += MAX_CHUNK) {
      const chunk = replay.slice(i, i + MAX_CHUNK);

      client.sendOutput(
        sessionID,
        { v: PROTOCOL_V, ev: 'SessionOutput', s: sessionID, seq, d: chunk },
        chunk.length,
      );
    }
  };

  const applyEffectiveDims = (sessionID: SessionID) => {
    const dims = attachments.findEffectiveDims(sessionID);

    if (dims === null) {
      return;
    }

    const runtime = runtimes.get(sessionID);
    const prev = runtime?.dims ?? null;

    if (prev !== null && prev.cols === dims.cols && prev.rows === dims.rows) {
      return;
    }

    const s = mgr.sessions.find((x) => x.id === sessionID);

    // A host that cannot resize keeps its terminal at the size it started
    // with; the screen model still follows the clients.
    if (s !== undefined && (mgr.findProvider(s)?.capabilities.resize ?? false)) {
      s.pty?.resize(dims.cols, dims.rows);
    }

    runtime?.screen?.updateDims(dims.cols, dims.rows);

    if (runtime !== undefined) {
      runtime.dims = dims;
    }

    emitEvent(
      {
        v: PROTOCOL_V,
        ev: 'SessionResized',
        s: sessionID,
        cols: dims.cols,
        rows: dims.rows,
      },
      findHookScope(sessionID),
    );
  };

  // Debounced so two clients resizing in opposite directions cannot produce
  // a SIGWINCH storm; a no-op effective size never reaches the PTY.
  const scheduleResize = (sessionID: SessionID) => {
    const runtime = runtimes.get(sessionID);

    if (runtime === undefined || runtime.resizeTimer !== undefined) {
      return;
    }

    runtime.resizeTimer = setTimeout(() => {
      runtime.resizeTimer = undefined;

      applyEffectiveDims(sessionID);
    }, 50);
  };

  const applyScreenJudgment = async (sessionID: SessionID) => {
    const s = mgr.sessions.find((x) => x.id === sessionID);
    const detector = s === undefined ? null : (mgr.findAdapter(s.agent)?.screenDetector ?? null);
    const model = runtimes.get(sessionID)?.screen ?? null;

    if (detector === null || model === null) {
      return;
    }

    const screen = await model.renderReplay();

    const judgment = detector.detectAttention(screen);

    if (judgment === 'needs-input') {
      mgr.updateAttention(sessionID, 'needs_you', 'waiting at a prompt');
    }

    if (judgment === 'working') {
      mgr.updateAttention(sessionID, 'running', 'working');
    }
  };

  // A spawned terminal starts on a fresh screen; a revived one keeps the
  // screen its session already had.
  mgr.onBoot = (s, cols, rows) => {
    const runtime = runtimes.get(s.id);

    if (runtime === undefined) {
      return;
    }

    runtime.resetBoot({ cols, rows });

    runtime.screen ??= new ScreenModel(cols, rows);
  };

  mgr.onOutput = (s, data) => {
    const runtime = runtimes.get(s.id);

    // The screen model consumes every byte continuously — background output
    // is consumed, not discarded.
    runtime?.screen?.record(data);
    scheduleDetect(s.id);

    const conns = attachments.collectClients(s.id);

    if (conns.length === 0) {
      return;
    }

    let seq = runtime?.seq ?? 0;

    for (let i = 0; i < data.length; i += MAX_CHUNK) {
      const chunk = data.slice(i, i + MAX_CHUNK);

      seq++;

      const event: EventMsg = { v: PROTOCOL_V, ev: 'SessionOutput', s: s.id, seq, d: chunk };

      for (const conn of conns) {
        conn.sendOutput(s.id, event, chunk.length);
      }
    }

    if (runtime !== undefined) {
      runtime.seq = seq;
    }
  };

  // A detach can outlive its session — a kill removes the session before the
  // client's connection closes — and a gone session already broadcast
  // SessionRemoved, so a descriptor miss emits nothing.
  const emitSessionDetached = (sessionID: SessionID) => {
    const session = mgr.collectDescriptors().find((x) => x.id === sessionID);

    if (session !== undefined) {
      emitEvent(
        { v: PROTOCOL_V, ev: 'SessionDetached', session },
        { cwd: session.cwd, repoRoot: session.repoRoot },
      );
    }
  };

  // Permission requests are synthesized from attention transitions: entering
  // needs_you opens one, and leaving it (answered directly in the terminal,
  // or the session dying) dismisses whatever is pending. Each session's
  // previous state is tracked purely to detect that transition.
  const lastStates = new Map<SessionID, SessionState>();

  const recordAttention: SessionManager['onEvent'] = (kind, s) => {
    if (kind === 'removed') {
      registry.answerAll(s.id, 'dismissed');
      lastStates.delete(s.id);

      return;
    }

    const prev = lastStates.get(s.id);

    lastStates.set(s.id, s.state);

    if (s.state === 'needs_you' && prev !== 'needs_you') {
      registry.open(s.id, s.lastMsg, false);
    }

    if (prev === 'needs_you' && s.state !== 'needs_you') {
      registry.answerAll(s.id, 'dismissed');
    }
  };

  mgr.onEvent = (kind, s) => {
    recordAttention(kind, s);

    if (kind === 'added') {
      runtimes.set(s.id, new SessionRuntime());
    }

    // A revive that dies before it ever announces itself must still release
    // the staggered restore, or a failed resume would hold up the fleet.
    if (kind === 'state' && s.pty === null) {
      runtimes.get(s.id)?.bootWaiter?.();
    }

    if (kind === 'removed') {
      attachments.removeSession(s.id);

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

  const recordHookEvent = async (e: HookEvent, ev: Readonly<AdapterEvent> | null) => {
    await store.recordEvent(e, ev);

    eventSignal.emit();
  };

  // A headless turn has no terminal hooks of its own, so the daemon writes
  // its start and end to the trail under a synthetic event name.
  const recordHeadlessTurnEvent = (sessionID: SessionID, ev: Readonly<AdapterEvent>) => {
    const s = mgr.sessions.find((x) => x.id === sessionID);

    void recordHookEvent(
      {
        atcId: sessionID,
        event: 'HeadlessTurn',
        payload: s?.agentSessionID === undefined ? {} : { session_id: s.agentSessionID },
      },
      ev,
    );
  };

  const applyHookEvent = (e: HookEvent) => {
    if (e.event === 'Report') {
      void applyReport(e);

      return;
    }

    const before = mgr.sessions.find((s) => s.id === e.atcId);
    const runtime = runtimes.get(e.atcId);

    // A harness nested inside a session inherits its environment and reports
    // under its id; only the harness atc started may change the session.
    if (
      before !== undefined &&
      runtime !== undefined &&
      !isOwnHookEvent(e.agent, before.agent, runtime.hasAgentHookLines)
    ) {
      return;
    }

    if (runtime !== undefined && e.agent !== undefined) {
      runtime.hasAgentHookLines = true;
    }

    const previousAgentSessionID = before?.agentSessionID;
    const ev = mgr.applyHook(e);

    // A headless session's trail comes from its runs alone: hook reports from
    // its dying terminal, or from a run's own CLI, stay out of it.
    const trailEvent = before?.kind === 'headless' ? null : ev;

    if (e.event !== 'Statusline') {
      void recordHookEvent(e, trailEvent);
    }

    const kind = ev?.kind ?? null;
    const currentAgentSessionID = mgr.sessions.find((s) => s.id === e.atcId)?.agentSessionID;

    if (currentAgentSessionID !== undefined && currentAgentSessionID !== previousAgentSessionID) {
      void store.updateMessageOwner(e.atcId, previousAgentSessionID, currentAgentSessionID);
      void store.updateTrailOwner(e.atcId, currentAgentSessionID);
    }

    if (kind === 'ended') {
      runtime?.pendingEject?.();
    }

    // A revived session announcing itself is the cue a staggered restore
    // waits on before booting the next one.
    if (kind === 'started') {
      if (runtime !== undefined) {
        runtime.startedAt = Date.now();
      }

      runtime?.bootWaiter?.();
      const started = mgr.sessions.find((s) => s.id === e.atcId);

      if (started !== undefined && runtime !== undefined && runtime.pendingLastUsed) {
        runtime.pendingLastUsed = false;
        void store.writeLastUsedAgent(started.agent);
      }
    }
  };

  const reporter = startHookServer(applyHookEvent, opts.reporterSocketPath);

  // A remote harness reports through a socket that serves it alone, so a
  // line that names any other session is dropped.
  mgr.onRelay = (binding, relay) => {
    startSessionBridge(relay, binding, {
      findSession: (sessionID) => mgr.sessions.find((x) => x.id === sessionID),
      applyHookEvent,
      applyReport: async (sessionID, payload, reportID) => {
        if (parseReport(payload) === null) {
          return false;
        }

        await applyReport({ atcId: sessionID, event: 'Report', payload: { ...payload } }, reportID);

        return true;
      },
      attachTap: (client, sessionID) => ctx.attachTap(client, sessionID, null),
      ackMessage: (client, sessionID, messageID) =>
        ctx.ackMessage(client, sessionID, messageID, null),
      detachTap: (client) => {
        taps.detachAll(client);
      },
    });
  };

  // A spawn with a workspace source materializes it once every refusal has
  // passed and its host is ready, and the session registers only once its
  // workspace is ready, so no session ever lists over a half-built checkout. A spawn that throws once its process has
  // started takes the session back before it throws, so a failed start
  // leaves nothing running and a keyed retry spawns once. When taking it
  // back fails too, the session may still stand, and the throw says so.
  const startSpawn = async (
    p: SpawnParams,
    id: SessionID,
    requireInReach: () => void = () => {},
  ): Promise<Readonly<Record<string, unknown>>> => {
    const source = p.workspace;
    let warnings: readonly string[] = [];

    const materialize =
      source === null
        ? null
        : async (
            host: Readonly<{
              readyHost: (
                attempt: number,
              ) => Promise<{ readonly host: SessionID; readonly dir: string }>;
              removeClaim: (dir: string) => Promise<boolean>;
            }>,
            targetIdentity: string,
          ) => {
            const prepared = await materializeSpawnWorkspace(p, id, source, host, targetIdentity);

            if (prepared.kind !== 'ready') {
              return null;
            }

            warnings = prepared.warnings;

            return prepared;
          };

    try {
      const session = await startSpawnedSession(p, id, materialize, requireInReach);

      return warnings.length === 0 ? { session } : { session, warnings };
    } catch (error) {
      // A failed spawn gives back the workspace directory it reserved,
      // unless what it did may still stand: its key then stays held as
      // outcome_unknown, and so does its directory.
      if (!(error instanceof EffectRemainsError)) {
        mgr.releaseWorkspace(id);
      }

      try {
        await mgr.removeFailedSpawn(id);
      } catch (cleanupError) {
        throw new EffectRemainsError(
          `spawn of session ${id} failed and taking it back failed too`,
          {
            cause: cleanupError,
          },
        );
      }

      throw error;
    }
  };

  // Materializes a spawn's workspace on the host its spawn readies once the
  // source resolves, under the target identity the spawn bound, and every
  // provider call passes the execution gate against that binding.
  const materializeSpawnWorkspace = (
    p: SpawnParams,
    id: SessionID,
    source: SpawnWorkspaceSource,
    host: Readonly<{
      readyHost: (attempt: number) => Promise<{ readonly host: SessionID; readonly dir: string }>;
      removeClaim: (dir: string) => Promise<boolean>;
    }>,
    targetIdentity: string,
  ) => {
    const binding = { target: p.target, targetIdentity };
    const bound = mgr.requireExecution(binding, 'run');

    return materializeWorkspace(
      {
        sessionID: id,
        target: p.target,
        dir: p.cwd,
        source,
        inPlace: bound.provider.kind === 'local-pty',
        autoDir: p.autoDir,
      },
      {
        requireProvider: (capability) => mgr.requireExecution(binding, capability).provider,
        store,
        log: (line) => {
          mgr.log(line);
        },
        readyHost: host.readyHost,
        removeClaim: host.removeClaim,
        stagingRoot: tmpdir(),
        gitTransports,
      },
    );
  };

  const startSpawnedSession = async (
    p: SpawnParams,
    id: SessionID,
    materialize:
      | ((
          host: Readonly<{
            readyHost: (
              attempt: number,
            ) => Promise<{ readonly host: SessionID; readonly dir: string }>;
            removeClaim: (dir: string) => Promise<boolean>;
          }>,
          targetIdentity: string,
        ) => Promise<Readonly<{
          workspace: SessionWorkspace;
          withheldEnv: readonly string[];
        }> | null>)
      | null,
    requireInReach: () => void,
  ): Promise<SessionDescriptor> => {
    const s = await mgr.spawn(
      p.cwd,
      p.name,
      p.prompt,
      p.cols,
      p.rows,
      p.resume,
      p.namedBy,
      p.agent,
      p.parent,
      p.overrides,
      id,
      p.target,
      materialize,
      requireInReach,
      p.autoDir,
    );

    const runtime = runtimes.get(s.id);

    if (runtime !== undefined) {
      runtime.pendingLastUsed = true;
    }

    void store.recordSpawnDir(s.cwd, { target: s.target, targetIdentity: s.targetIdentity });

    return getDescriptor(mgr, s.id);
  };

  // A retried spawn answers with the session as it stands now when it is
  // listed, else with the descriptor the first spawn answered. A key that
  // start-up reconciliation completed has no stored answer, and its session
  // lists only once the fleet is restored.
  const loadSpawnReplay = (record: IdempotencyRecord): Readonly<Record<string, unknown>> => {
    const listed = mgr.collectDescriptors().find((d) => d.id === record.effectRef);

    if (listed !== undefined) {
      return { session: listed };
    }

    const stored: unknown = record.result === null ? null : JSON.parse(record.result);

    if (isRecord(stored)) {
      return stored;
    }

    throw new DaemonError(
      'no_such_session',
      `the spawn under idempotency key '${record.key}' created session '${record.effectRef}', which is not listed; restore the fleet to list it`,
      { effectRef: record.effectRef },
    );
  };

  const ledger = new IdempotencyLedger(store, LOCAL_PRINCIPAL, (line) => {
    mgr.log(line);
  });

  // Throws the refusal a fresh spawn to the target gets when the access
  // does not reach the target, and the identity, a held spawn key recorded
  // for its session. A key that records none is refused: nothing it holds
  // shows where its session ran. A session the daemon still holds is
  // refused the same way when the access does not reach its whole tree.
  const requireReplayInReach = (record: IdempotencyRecord, access: TargetAccess): void => {
    const bound = record.effectTarget;

    if (bound === null) {
      throw buildTargetForbiddenError(findReplayTarget(record));
    }

    const session = mgr.sessions.find((x) => x.id === record.effectRef);

    if (
      !access.canUse(bound) ||
      (session !== undefined && !isTreeInReach(mgr.sessions, session.id, access))
    ) {
      throw buildTargetForbiddenError(bound.target);
    }
  };

  // Throws the refusal of a replay out of reach when a held spawn key's
  // session is no longer live and the access does not reach the whole tree
  // its fleet rows hold, as the live check refuses a live tree. A session
  // with no fleet row has no tree left to check.
  const requireStoredTreeInReach = async (
    record: IdempotencyRecord,
    access: TargetAccess,
  ): Promise<void> => {
    if (mgr.sessions.some((x) => x.id === record.effectRef)) {
      return;
    }

    const fleet = await store.loadFleet();

    const members = fleet.map((entry) => {
      const grant = buildGrantFromFleetEntry(entry);

      return {
        id: entry.sessionID,
        parent: entry.parent ?? null,
        target: grant.target,
        targetIdentity: grant.targetIdentity,
      };
    });

    const own = members.find((member) => member.id === record.effectRef);

    if (own !== undefined && !isTreeInReach(members, own.id, access)) {
      throw buildTargetForbiddenError(record.effectTarget?.target ?? findReplayTarget(record));
    }
  };

  // Each confirm token a forget handed out, by token: the session it
  // forgets, when it stops being taken, and whether a forget took it. A
  // token stays known for one more lifetime after it expires, so a late
  // forget learns it expired rather than that it never existed.
  const confirmTokens = new Map<string, ConfirmToken>();

  const forgetConfirmMs = opts.forgetConfirmMs ?? FORGET_CONFIRM_MS;

  const claimConfirmToken = (sessionID: SessionID, token: string) => {
    const now = Date.now();

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

  // Why the session refuses a message right now, or null when it takes one.
  const findMessageRefusal = (sessionID: SessionID): MessageRefusal | null => {
    const s = mgr.sessions.find((x) => x.id === sessionID);

    if (s === undefined) {
      return 'missing';
    }

    if (!(s.pty !== null || (s.kind === 'headless' && s.state !== 'exited'))) {
      return 'dead';
    }

    if (mgr.findAdapter(s.agent)?.takesMessages !== true) {
      return 'unsupported';
    }

    const runtime = runtimes.get(sessionID);

    if (
      runtime !== undefined &&
      runtime.startedAt !== null &&
      !runtime.tapAttached &&
      Date.now() - runtime.startedAt >= (opts.tapGraceMs ?? TAP_GRACE_MS)
    ) {
      return 'no_tap';
    }

    return null;
  };

  // Writes the message under the id given, notes it in the trail, and hands
  // it to the session's tap when one is attached. Only the write itself can
  // reject: every later step swallows its own failure, so a rejection means
  // no message was written.
  // The caller's check runs again once the writes ahead of this one land,
  // before anything is written; a failed check writes nothing.
  const writeAcceptedMessage = async (
    sessionID: SessionID,
    from: string,
    text: string,
    id: MessageID,
    requireWriteInReach: () => void,
  ): Promise<MessageRecord> => {
    const s = mgr.sessions.find((x) => x.id === sessionID);
    const previousWrite = lastMessageWrite;
    const written = Promise.withResolvers<void>();

    lastMessageWrite = written.promise;

    await previousWrite;

    const record: MessageRecord = {
      id,
      atcID: sessionID,
      ...(s?.agentSessionID === undefined ? {} : { agentSessionID: s.agentSessionID }),
      from,
      text,
      status: 'accepted',
      sentAt: Date.now(),
    };

    try {
      // The write boundary: the reach check and the start of the row write
      // run in one synchronous step, so no wait lets the session's tree
      // leave the access between the check and the write it allows.
      requireWriteInReach();

      await store.writeMessage(record);

      await recordMessageStatus(sessionID, record);
    } finally {
      written.resolve();
    }

    await drainSessionInbox(sessionID);

    return record;
  };

  const startedAt = new Date().toISOString();

  // Sends a restored session the message that carries on a turn the
  // previous daemon's stop cut off. A resume message still pending from an
  // earlier restart covers this one, so a session never holds two.
  const sendResumeMessage = async (s: Session): Promise<void> => {
    const pending = await store.collectPendingMessages(buildMessageOwner(s));

    if (
      pending.some((record) => record.from === RESUME_SENDER && record.text.startsWith(RESUME_LEAD))
    ) {
      return;
    }

    const refusal = findMessageRefusal(s.id);

    if (refusal !== null) {
      mgr.log(`atc sent session ${s.id} no resume message (${refusal})`);

      return;
    }

    await writeAcceptedMessage(
      s.id,
      RESUME_SENDER,
      `${RESUME_LEAD} at ${startedAt}; your last turn was interrupted. Check the state of anything you had in flight, then continue.`,
      mintMessageID(),
      () => {},
    );
  };

  // A retried send answers with the message's current status, so a caller
  // that lost the first answer learns where its message stands now.
  const loadMessageReplay = async (
    record: IdempotencyRecord,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const current = await store.findMessageByID(toMessageID(record.effectRef));

    if (current !== null) {
      return { message: current.id, status: current.status };
    }

    const stored: unknown = record.result === null ? null : JSON.parse(record.result);

    if (isRecord(stored)) {
      return stored;
    }

    throw new DaemonError(
      'internal',
      `the message under idempotency key '${record.key}' has no stored row`,
      { effectRef: record.effectRef },
    );
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

  const sources = opts.sources ?? [];

  const ctx: DaemonContext = {
    build: opts.build,
    daemonID: store.daemonID,
    idempotencyRetentionMs: IDEMPOTENCY_TTL_MS,
    collectSessions: () => mgr.collectDescriptors(),
    collectSpawnDirs: async (access) => {
      const dirs = await store.collectSpawnDirs();

      const reached = dirs.filter((dir) => access === null || access.canUse(dir.grant));

      return [...new Set(reached.map((dir) => dir.cwd))];
    },
    collectAgents: () => ({
      daemon: {
        hostname: hostname(),
        platform: process.platform,
        arch: process.arch,
        build: opts.build,
      },
      agents: buildAgentList(
        mgr.collectAdapters(),
        (bin) => Bun.which(bin) !== null,
        targets.some((target) => target.provider?.brokerAuth !== undefined),
      ),
      targets: buildTargetList(targets, defaultTarget),
      spawnDefaults: { agent: 'claude', target: defaultTarget },
      configRevision,
      targetErrors,
      sources: sources.map((source) => ({
        id: source.id,
        label: source.label,
        kind: source.kind,
      })),
    }),
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
    findPermissionSession: (request) => registry.findSessionID(request),
    resolveSpawnParent: (id) => {
      const owner = mgr.sessions.find((x) => x.id === id);

      if (owner === undefined) {
        return 'missing';
      }

      return owner.parent ?? owner.id;
    },
    resolveSpawnTarget: (requested) => {
      const target = requested ?? defaultTarget;
      const refusal = mgr.findExecutionRefusal({ target, targetIdentity: null }, 'spawn');

      if (refusal !== null) {
        throw refusal;
      }

      if (target === null) {
        throw new Error('a spawn without a target passed its checks');
      }

      return target;
    },
    requireWorkspaceTarget: (target) => {
      mgr.requireExecution({ target, targetIdentity: null }, 'transfer');
      mgr.requireExecution({ target, targetIdentity: null }, 'run');
    },
    buildDefaultWorkspaceDir: (target, source) =>
      buildDefaultWorkspaceDir(source, {
        root: opts.workspaceRoots?.targetRoots.get(target) ?? opts.workspaceRoots?.root ?? null,
        remote: mgr.requireExecution({ target, targetIdentity: null }, 'run').provider.remote,
        home: resolveHomeDir(),
      }),
    requireAgentTarget: (agent, target) => {
      mgr.requireAgentTarget(agent, target);
    },
    findSource: (id) => sources.find((source) => source.id === id) ?? null,
    collectAlternateGitURLs: (url) => [
      ...new Set(sources.flatMap((source) => source.findAlternateURLs?.(url) ?? [])),
    ],
    checkRepositoryAccess: (request) =>
      checkRepositoryAccess({ ...request, transports: requireGitTransports(gitTransports) }),
    spawnSession: (plan, keyed, access) => {
      // Under an access, a spawn under a parent whose tree leaves the access
      // before the harness starts is refused as a spawn under an unknown
      // parent.
      const startInReach = (p: SpawnParams, id: SessionID) =>
        startSpawn(p, id, () => {
          if (
            access !== null &&
            p.parent !== null &&
            !isTreeInReach(mgr.sessions, p.parent, access)
          ) {
            throw new DaemonError('no_such_session', `no session '${p.parent}'`);
          }
        });

      if (keyed === null) {
        return startInReach(plan(), mintSessionID());
      }

      const effectRef = mintSessionID();

      return ledger.run({
        operation: 'session.spawn',
        keyed,
        effectRef,
        start: () => startInReach(plan(), effectRef),
        settle: () => mgr.writeFleet(),
        replay: async (record) => {
          if (access === null) {
            return loadSpawnReplay(record);
          }

          requireReplayInReach(record, access);

          await requireStoredTreeInReach(record, access);

          // The tree may change while the fleet is read, so the live check
          // runs again in the step that answers.
          requireReplayInReach(record, access);

          return loadSpawnReplay(record);
        },
        findEffectTarget: () => {
          const s = mgr.sessions.find((x) => x.id === effectRef);

          return s === undefined ? null : { target: s.target, targetIdentity: s.targetIdentity };
        },
      });
    },
    updateSession: (id, name, pinned) => mgr.updateSession(id, name, pinned),
    quitDaemon: () => {
      // The ok response for the quit request must flush before the sockets
      // close under it.
      setTimeout(() => {
        void (async () => {
          await stopDaemon?.();

          opts.onQuit?.();
        })();
      }, 80);
    },
    killSession: async (id) => {
      const s = mgr.sessions.find((x) => x.id === id);

      if (s === undefined) {
        return false;
      }

      for (const live of [s, ...mgr.collectChildren(id)]) {
        if (live.pty !== null) {
          mgr.requireExecution(live, mgr.pickKillCapability(live));
        }
      }

      const set = [s, ...mgr.collectChildren(id)];

      await mgr.kill(id);

      stopEndedHeadlessRuns(set);

      return true;
    },

    // A forget on a target that cannot destroy its host forgets at once. On
    // one that can, a forget without a token checks the target and answers
    // with a token, and the forget that carries the token destroys the host.
    forgetSession: async (id, confirmToken) => {
      const s = mgr.sessions.find((x) => x.id === id);

      if (s === undefined) {
        return 'missing';
      }

      if (mgr.findProvider(s)?.capabilities.destroy === true) {
        mgr.requireExecution(s, 'destroy');

        if (confirmToken === undefined) {
          const token = randomUUID();
          const expiresAt = Date.now() + forgetConfirmMs;

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
    ejectSession: (id, prompt) => {
      const s = mgr.sessions.find((x) => x.id === id);

      if (s === undefined) {
        return 'missing';
      }

      const adapter = mgr.findAdapter(s.agent);

      if (adapter === null || adapter.headlessRunner === null) {
        return 'unsupported';
      }

      if (!hasResumableTranscript(mgr, id)) {
        return 'no_transcript';
      }

      mgr.requireExecution(s, 'kill');
      mgr.requireExecution(s, 'headless');

      const yanked = mgr.yankHeadless(id);

      if (yanked === null) {
        return 'missing';
      }

      const runtime = runtimes.get(id);

      if (runtime === undefined) {
        return 'missing';
      }

      runEjectHandoff({
        sessionID: id,
        prompt,
        settleMs: opts.ejectSettleMs ?? 4000,
        runtime,
        startHeadlessTurn: (sid, p) =>
          startHeadlessTurn(mgr, findRuntime, sid, p, recordHeadlessTurnEvent),
      });

      return 'ok';
    },
    adoptSession: async (id, cols, rows, access) => {
      if (!hasResumableTranscript(mgr, id)) {
        return 'no_transcript';
      }

      const listed = mgr.sessions.find((s) => s.id === id);

      // Refused before the headless run stops, so a refusal leaves it as
      // it was.
      if (listed !== undefined) {
        mgr.requireAgentTarget(listed.agent, listed.target);
      }

      const runtime = runtimes.get(id);

      runtime?.stopHeadlessRun();

      const adopted = await mgr.adoptTerminal(
        id,
        cols,
        rows,
        () => access === null || isTreeInReach(mgr.sessions, id, access),
      );

      if (adopted === null) {
        return 'missing';
      }

      scheduleResize(id);

      return 'ok';
    },
    ackSession: (id) => {
      if (!mgr.sessions.some((s) => s.id === id)) {
        return false;
      }

      mgr.ack(id);

      return true;
    },
    buildResumeCommand: (id) => mgr.buildResumeCommand(id),

    // A killed session keeps its last screen until a second kill removes
    // it, so a reader can still see what the agent printed before it died.
    readSessionScreen: (id) => {
      if (!mgr.sessions.some((x) => x.id === id)) {
        return Promise.resolve('missing');
      }

      const screen = runtimes.get(id)?.screen ?? null;

      return screen === null ? Promise.resolve('no_screen') : screen.renderText();
    },
    answerPermission: (request, decision) => registry.answer(request, decision),
    attachSession: (client, sessionID, dims) => {
      const s = mgr.sessions.find((x) => x.id === sessionID);

      if (s === undefined) {
        return 'missing';
      }

      if (s.pty === null) {
        return 'dead';
      }

      mgr.requireExecution(s, 'attach');
      attachments.attach(sessionID, client, dims);
      mgr.attach(sessionID);

      // The PTY and screen model take the new effective size before the
      // replay renders, so the repaint arrives at the attaching terminal's
      // own dims instead of the previous attachment's — a replay at stale
      // dims paints vertically misaligned and the agent's resize repaint
      // only redraws its live region, never the rows above it.
      applyEffectiveDims(sessionID);
      void sendReplay(sessionID, client);
      const attached = getDescriptor(mgr, sessionID);

      emitEvent(
        { v: PROTOCOL_V, ev: 'SessionAttached', session: attached },
        { cwd: attached.cwd, repoRoot: attached.repoRoot },
      );

      return 'ok';
    },
    detachSession: (client, sessionID) => {
      if (!attachments.detach(sessionID, client)) {
        return;
      }

      scheduleResize(sessionID);
      emitSessionDetached(sessionID);
    },
    detachClient: (client) => {
      for (const sessionID of attachments.detachAll(client)) {
        scheduleResize(sessionID);
        emitSessionDetached(sessionID);
      }
    },
    writeSessionInput: (sessionID, data) => {
      const s = mgr.sessions.find((x) => x.id === sessionID);

      if (s === undefined) {
        return 'missing';
      }

      // A headless turn runs only through the session's own target, never
      // anywhere else, and a dead session takes no input.
      if (s.kind === 'headless') {
        mgr.requireExecution(s, 'headless');

        if (s.state === 'exited') {
          return 'dead';
        }

        if ((runtimes.get(sessionID)?.headlessRun ?? null) !== null) {
          return 'busy';
        }

        return startHeadlessTurn(
          mgr,
          findRuntime,
          sessionID,
          data.trimEnd(),
          recordHeadlessTurnEvent,
        )
          ? 'ok'
          : 'dead';
      }

      if (s.pty === null) {
        return 'dead';
      }

      mgr.requireExecution(s, 'input');
      s.pty.write(data);

      return 'ok';
    },
    writeSessionLine: (sessionID, text) => {
      const s = mgr.sessions.find((x) => x.id === sessionID);

      // A headless turn takes the line as its prompt, and a missing or dead
      // session refuses a line as it refuses raw input.
      if (s === undefined || s.kind === 'headless' || s.pty === null) {
        return ctx.writeSessionInput(sessionID, text);
      }

      mgr.requireExecution(s, 'input');

      const bracketedPaste = runtimes.get(sessionID)?.screen?.hasBracketedPaste() ?? false;
      const adapter = mgr.findAdapter(s.agent);
      const writes = adapter?.planLineInput?.(text, { bracketedPaste }) ?? planTypedLineInput(text);

      // Every write goes out in the tick the request arrives in, so no input
      // overtakes the line and none lands between the text and its submit
      // key.
      for (const data of writes) {
        s.pty.write(data);
      }

      return 'ok';
    },
    resizeSession: (client, sessionID, dims) => {
      if (!attachments.updateDims(sessionID, client, dims)) {
        return false;
      }

      scheduleResize(sessionID);

      return true;
    },
    resyncClient: sendReplay,
    ...(opts.queueBytes === undefined ? {} : { queueBytes: opts.queueBytes }),
    getEffectiveDims: (sessionID) =>
      attachments.findEffectiveDims(sessionID) ??
      runtimes.get(sessionID)?.dims ?? { cols: 80, rows: 24 },
    restoreFleet: (cols, rows) =>
      restoreFleet({
        mgr,
        store,
        findRuntime,
        cols,
        rows,
        capMs: opts.restoreBootTimeoutMs ?? 0,
        resumeInterruptedTurns: opts.resumeInterruptedTurns ?? false,
        sendResumeMessage,
      }),
    readSessionRecord: async (id, access) => {
      const s = mgr.sessions.find((x) => x.id === id);

      if (s === undefined) {
        return 'missing';
      }

      // Every session-derived field is taken before the await: a kill or a
      // hook may change the session meanwhile.
      const session = getDescriptor(mgr, id);
      const prompt = s.prompt ?? null;
      const pending = s.state === 'needs_you' ? { message: s.lastMsg } : null;
      const result = s.result ?? null;
      const createdAt = s.createdAt;

      // The agent session id links rows from before atc ids stayed stable,
      // unless a session on another target resumed the same agent session,
      // whose rows it would match too. Under an access it links nothing: a
      // session that shared it may be gone, its rows still in the trail.
      const shared = mgr.sessions.some(
        (x) =>
          x.agentSessionID === s.agentSessionID &&
          (x.target !== s.target || x.targetIdentity !== s.targetIdentity),
      );

      const linked = access !== null || shared ? undefined : s.agentSessionID;

      const lastEventAt = await store.loadLastActivityAt(s.id, linked);

      return {
        session,
        prompt,
        lastActivityAt: lastEventAt ?? createdAt,
        pending,
        result,
      };
    },
    loadSessionTranscript: async (id, from, limit) => {
      const s = mgr.sessions.find((x) => x.id === id);

      if (s === undefined) {
        return 'missing';
      }

      const parseLine = mgr.findAdapter(s.agent)?.parseTranscriptLine;

      if (parseLine === undefined) {
        return 'unsupported';
      }

      const path = s.transcriptPath ?? '';

      if (path === '') {
        return { path, page: { rows: [], offset: 0, more: false } };
      }

      // A page stays far under the protocol's 1 MiB line cap.
      const page = await loadTranscriptPage({ path, from, limit, maxBytes: 262_144, parseLine });

      return { path, page };
    },
    readEvents: async (afterID, limit, waitMs, sessionID, access) => {
      const deadline = Date.now() + waitMs;

      // A wake for an event the read leaves out (a heartbeat, or another
      // session's event under a session filter) loops back to wait out the
      // rest of the window. The scope is built again after every await, so
      // a session whose tree left the access while the read waited matches
      // nothing, and a read whose scope changed under its query runs again.
      for (;;) {
        const generation = eventSignal.generation;
        const scope = buildEventScope(sessionID, access);

        // A read from a cursor takes one row past the limit to learn whether
        // more follow; the latest events have nothing after them.
        const rows =
          afterID === null
            ? await store.collectLatestEvents(limit, scope)
            : await store.collectEventsAfter(afterID, limit + 1, scope);

        if (
          access !== null &&
          JSON.stringify(buildEventScope(sessionID, access)) !== JSON.stringify(scope)
        ) {
          continue;
        }

        const remaining = deadline - Date.now();

        if (rows.length > 0 || remaining <= 0 || eventSignal.disposed) {
          const naming = collectNamingDescriptors(access);

          // Under an access an event takes no alias, so each event keeps the
          // atc id it was recorded under for the check that sends it.
          const aliases = access === null ? naming : [];

          return {
            events: buildFleetEvents(rows.slice(0, limit), naming, aliases),
            more: rows.length > limit,
          };
        }

        await eventSignal.waitForNext(generation, remaining);
      }
    },
    readReport: async (id, access) => {
      const stored = await store.findReport(id, buildEventScope(null, access));

      if (stored === null) {
        return null;
      }

      const naming = collectNamingDescriptors(access);
      const aliases = access === null ? naming : [];

      // Under an access a report takes no alias, so a session in reach
      // never names a report whose own session left the access while the
      // query waited.
      return {
        owner: stored.atcID,
        view: buildReportView(stored, naming, aliases),
      };
    },
    writeSessionMessage: async (sessionID, from, text, keyed, access) => {
      // Under an access, a session whose tree leaves the access before the
      // message is written refuses it as an unknown session does.
      const requireInReach = () => {
        if (access !== null && !isTreeInReach(mgr.sessions, sessionID, access)) {
          throw new MessageRefusedError('missing');
        }
      };

      if (keyed === null) {
        const refusal = findMessageRefusal(sessionID);

        if (refusal !== null) {
          return refusal;
        }

        try {
          const record = await writeAcceptedMessage(
            sessionID,
            from,
            text,
            mintMessageID(),
            requireInReach,
          );

          return { message: record.id, status: record.status };
        } catch (error) {
          if (error instanceof MessageRefusedError) {
            return error.refusal;
          }

          throw error;
        }
      }

      const effectRef = mintMessageID();

      try {
        return await ledger.run({
          operation: 'session.message',
          keyed,
          effectRef,

          // A refusal throws, so the claim drops and a retry runs fresh.
          start: async () => {
            requireInReach();

            const refusal = findMessageRefusal(sessionID);

            if (refusal !== null) {
              throw new MessageRefusedError(refusal);
            }

            const record = await writeAcceptedMessage(
              sessionID,
              from,
              text,
              effectRef,
              requireInReach,
            );

            return { message: record.id, status: record.status };
          },

          // The message row is the effect, and the start already wrote it.
          settle: () => Promise.resolve(),
          replay: (record) => loadMessageReplay(record),
        });
      } catch (error) {
        if (error instanceof MessageRefusedError) {
          return error.refusal;
        }

        throw error;
      }
    },
    attachTap: (client, sessionID, access) => {
      const s = mgr.sessions.find((x) => x.id === sessionID);

      if (s === undefined) {
        return 'missing';
      }

      if (mgr.findAdapter(s.agent)?.takesMessages !== true) {
        return 'unsupported';
      }

      emitInboxClosed(taps.attach(sessionID, client, access === null), sessionID, 'replaced');

      const runtime = runtimes.get(sessionID);

      if (runtime !== undefined) {
        runtime.tapAttached = true;
      }

      void drainSessionInbox(sessionID);

      return 'ok';
    },
    detachTap: (client, sessionID) => {
      if (taps.isTap(sessionID, client)) {
        taps.removeSession(sessionID);
      }
    },
    readMessage: async (messageID, waitMs) => {
      const deadline = Date.now() + waitMs;
      let initialStatus: MessageStatus | null = null;

      // Every message status change writes a trail entry and wakes the
      // signal, so a wake re-reads the message and returns once its status
      // moved from the status at call time. An answered message has no
      // further status to wait for.
      for (;;) {
        const generation = eventSignal.generation;

        const view = await readMessageView(messageID);

        if (view === null) {
          return null;
        }

        initialStatus ??= view.record.status;

        const remaining = deadline - Date.now();

        if (
          view.record.status !== initialStatus ||
          view.record.status === 'answered' ||
          remaining <= 0 ||
          eventSignal.disposed
        ) {
          return view;
        }

        await eventSignal.waitForNext(generation, remaining);
      }
    },
    ackMessage: async (client, sessionID, messageID, access) => {
      const s = mgr.sessions.find((x) => x.id === sessionID);

      if (s === undefined || !taps.isTap(sessionID, client)) {
        return 'not_tapping';
      }

      // Under an access, only a message sent to this atc id is the
      // session's to ack, as with the inbox drain.
      const owner = access === null ? buildMessageOwner(s) : { atcID: s.id };

      const delivered = await store.updateMessageDelivered(messageID, owner, Date.now());

      void drainSessionInbox(sessionID);

      if (delivered !== null) {
        await recordMessageStatus(sessionID, delivered);

        return delivered;
      }

      const current = await store.findMessage(messageID, owner);

      return current ?? 'unknown';
    },
  };

  // Releases everything the daemon holds except its listeners, on a stop
  // and on a start that fails once it holds the lock.
  const releaseResources = async () => {
    clearInterval(idempotencySweep);
    eventsServer?.stop();
    reporter.stop(true);
    mgr.detachAll();

    for (const target of targets) {
      target.provider?.dispose();
    }

    for (const runtime of runtimes.values()) {
      runtime.dispose();
    }

    runtimes.clear();
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

  // oxlint-disable-next-line prefer-readonly-parameter-types -- a connection is a live object the daemon releases
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
        ? createNonBlockingLog(STDERR_FD)
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
        now: opts.listen.now ?? Date.now,
        refusalLogIntervalMs: opts.listen.refusalLogIntervalMs ?? REFUSAL_LOG_INTERVAL_MS,
        maxRefusalWindows: opts.listen.maxRefusalWindows ?? MAX_REFUSAL_WINDOWS,
      });
    } catch (error) {
      await releaseResources();

      throw buildBindRefusal(opts.listen, error);
    }
  }

  try {
    unlinkSync(opts.socketPath);
  } catch {}

  const server = Bun.listen<DaemonConnection>({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        socket.data = new DaemonConnection(socket, ctx);

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
  });

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

  stopDaemon = async () => {
    // Ends each client itself so every peer sees the close: a stopped
    // listener does not reliably end the connections it already accepted.
    for (const client of clients) {
      client.dispose();
    }

    tcpListener?.stop();
    server.stop(true);

    await releaseResources();

    // The stopped listener logs no more lines, so this writes the ones the
    // log still holds, waiting no longer than the timeout when nothing reads
    // stderr.
    await listenerLog?.drain(LOG_DRAIN_TIMEOUT_MS);
  };

  writeDaemonRecord(recordPath, {
    pid: process.pid,
    socketPath: opts.socketPath,
    reporterSocketPath: opts.reporterSocketPath,
    eventsSocketPath: opts.eventsSocketPath ?? null,
    listenPort: tcpListener?.port ?? null,
  });

  return {
    stop: stopDaemon,
    countClients: () => clients.size,
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
    throw Object.assign(
      new Error(
        `atc daemon: --listen refuses '${listen.host}': bind a loopback address or one in 100.64.0.0/10 or fd7a:115c:a1e4::/48`,
      ),
      { code: 'listen_refused' },
    );
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

// Tells a tap its subscription is over so the `atc tap` process behind it
// exits instead of idling on a session it no longer serves.
function emitInboxClosed(
  tap: TapClient | null,
  sessionID: SessionID,
  reason: 'replaced' | 'removed',
): void {
  tap?.sendEvent({ v: PROTOCOL_V, ev: 'InboxClosed', s: sessionID, reason });
}

function buildMessageOwner(s: Session): MessageOwner {
  return {
    atcID: s.id,
    ...(s.agentSessionID === undefined ? {} : { agentSessionID: s.agentSessionID }),
  };
}

function hasResumableTranscript(mgr: SessionManager, id: SessionID): boolean {
  const s = mgr.sessions.find((x) => x.id === id);

  if (s === undefined) {
    return false;
  }

  const adapter = mgr.findAdapter(s.agent);

  if (adapter === null) {
    return false;
  }

  // A remote session's transcript lives in its host, out of the daemon's
  // reach, so the agent's session id alone makes it resumable.
  if (mgr.findProvider(s)?.remote === true) {
    return s.agentSessionID !== undefined;
  }

  return adapter.canResume({
    ...(s.agentSessionID === undefined ? {} : { agentSessionID: s.agentSessionID }),
    ...(s.transcriptSource === undefined ? {} : { transcriptSource: s.transcriptSource }),
  });
}

function getDescriptor(mgr: SessionManager, id: SessionID): SessionDescriptor {
  const d = mgr.collectDescriptors().find((x) => x.id === id);

  if (d === undefined) {
    throw new Error(`descriptor for unknown session ${id}`);
  }

  return d;
}

// A sweep that fails leaves the keys for the next one.
async function tryRemoveExpiredIdempotencyKeys(store: StateStore): Promise<boolean> {
  try {
    await store.removeExpiredIdempotencyKeys(Date.now() - IDEMPOTENCY_TTL_MS);
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

// Carries a message refusal out of a keyed send's start, so the claim drops
// and the refusal still answers the request.
class MessageRefusedError extends Error {
  readonly refusal: MessageRefusal;

  constructor(refusal: MessageRefusal) {
    super(`message refused: ${refusal}`);

    this.refusal = refusal;
    this.name = 'MessageRefusedError';
  }
}

// The target a held spawn key's stored answer holds its session on, for a
// refusal of its replay; the answer holds no other target to name.
function findReplayTarget(record: IdempotencyRecord): string {
  const stored: unknown = record.result === null ? null : JSON.parse(record.result);
  const session = isRecord(stored) ? stored['session'] : null;
  const locator = isRecord(session) ? session['locator'] : null;

  return isRecord(locator) && typeof locator['targetID'] === 'string'
    ? locator['targetID']
    : 'unknown';
}
