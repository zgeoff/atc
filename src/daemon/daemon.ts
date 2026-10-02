import { unlinkSync, writeFileSync } from 'node:fs';
import type { AdapterEvent, AgentAdapter } from '../agents/agent-adapter';
import { MAX_CHUNK, PROTOCOL_V } from '../protocol/protocol';
import type { EventMsg } from '../protocol/protocol';
import type { HooksConfig } from '../shared/collect-hooks';
import type { SessionID } from '../shared/session-id';
import { truncateToBytes } from '../shared/truncate-to-bytes';
import type { MessageOwner } from '../store/message-owner';
import type { MessageRecord } from '../store/message-record';
import { StateStore } from '../store/state-store';
import type { TrailEntry } from '../store/trail-entry';
import { ANSWER_BYTE_CAP } from './answer-byte-cap';
import { AttachRegistry } from './attach-registry';
import { buildFleetEvents } from './build-fleet-events';
import { buildMessageTrailEntry } from './build-message-trail-entry';
import { buildReportTrailEntry } from './build-report-trail-entry';
import { buildSessionEvent } from './build-session-event';
import { buildSessionMessageEvent } from './build-session-message-event';
import { buildSessionReportEvent } from './build-session-report-event';
import { DaemonConnection } from './daemon-connection';
import type { DaemonContext, OutputClient, TapClient } from './daemon-connection';
import { EventSignal } from './event-signal';
import { startHookServer } from './hooks';
import type { HookEvent } from './hooks';
import { loadTranscriptPage } from './load-transcript-page';
import { makeHookRunner } from './make-hook-runner';
import type { HookScope } from './make-hook-runner';
import { mintMessageID } from './mint-message-id';
import { parseReport } from './parse-report';
import { PermissionRegistry } from './permission-registry';
import { restoreFleet } from './restore-fleet';
import { runEjectHandoff } from './run-eject-handoff';
import { ScreenModel } from './screen-model';
import { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';
import type { Session, SessionDescriptor, SessionState } from './sessions';
import { startEventsServer } from './start-events-server';
import { startHeadlessTurn } from './start-headless-turn';
import { TapRegistry } from './tap-registry';

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

  // Called after a client-requested quit has stopped the daemon; the real
  // entrypoint exits the process, tests leave it unset.
  readonly onQuit?: () => void;
}

export interface DaemonHandle {
  readonly stop: () => Promise<void>;
}

// How long a started Claude session may go without a tap before a message to
// it is refused.
const TAP_GRACE_MS = 15_000;

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

  if (opts.pidPath !== undefined) {
    writeFileSync(opts.pidPath, String(process.pid));
  }

  const store = await StateStore.open(opts.dbPath, opts.legacyFleetPath);

  const mgr = new SessionManager(opts.adapter, store, opts.statusPath, opts.adapters ?? []);
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
  // oxlint-disable-next-line prefer-readonly-parameter-types -- every field is readonly; the branded id has no readonly form to wrap it in
  const recordTrailEntry = async (entry: TrailEntry) => {
    try {
      await store.recordTrailEntry(entry);
    } catch {
      return;
    }

    eventSignal.emit();
  };

  // Notes a message status change in the trail before broadcasting it, so a
  // client reading the trail on the broadcast finds the change already there.
  // oxlint-disable-next-line prefer-readonly-parameter-types -- every field is readonly; the branded id has no readonly form to wrap it in
  const recordMessageStatus = async (sessionID: SessionID, record: MessageRecord) => {
    const s = mgr.sessions.find((x) => x.id === sessionID);

    await recordTrailEntry(buildMessageTrailEntry(sessionID, s?.agentSessionID, record));

    emitEvent(buildSessionMessageEvent(sessionID, record), findHookScope(sessionID));
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

  // Hands one pending message to the session's tap, once, and reports whether
  // it did. The event goes to the tap connection alone: it never reaches
  // other clients, the events socket, or hooks.
  // oxlint-disable-next-line prefer-readonly-parameter-types -- every field is readonly; the branded id has no readonly form to wrap it in
  const sendInboxMessage = (sessionID: SessionID, record: MessageRecord): boolean => {
    const tap = taps.claimDelivery(sessionID, record.id);

    if (tap === null) {
      return false;
    }

    tap.sendEvent({
      v: PROTOCOL_V,
      ev: 'InboxMessage',
      s: sessionID,
      message: record.id,
      from: record.from,
      text: record.text,
      sentAt: record.sentAt,
    });

    return true;
  };

  // Reads the backlog from the store before sending anything, so a tap's
  // ok response is always queued ahead of its first message. It sends one
  // unclaimed message per call and the tap's ack calls it again, so the
  // backlog never outgrows the connection's outbound queue.
  const drainInbox = async (sessionID: SessionID) => {
    const s = mgr.sessions.find((x) => x.id === sessionID);

    if (s === undefined) {
      return;
    }

    try {
      const pending = await store.collectPendingMessages(buildMessageOwner(s));

      for (const record of pending) {
        if (sendInboxMessage(sessionID, record)) {
          return;
        }
      }
    } catch {}
  };

  const applyReport = async (e: HookEvent) => {
    const report = parseReport(e.payload);

    if (report === null) {
      return;
    }

    if (report.kind === 'note') {
      const sender = mgr.sessions.find((x) => x.id === e.atcId);

      if (sender !== undefined) {
        const capped = { ...report, text: truncateToBytes(report.text, ANSWER_BYTE_CAP) };
        const reportedAt = Date.now();

        await recordTrailEntry(
          buildReportTrailEntry(sender.id, sender.agentSessionID, capped, reportedAt),
        );

        emitEvent(buildSessionReportEvent(sender.id, capped, reportedAt), findHookScope(sender.id));
      }

      return;
    }

    const s = mgr.sessions.find((x) => x.id === e.atcId);
    const owner = s === undefined ? { atcID: e.atcId } : buildMessageOwner(s);

    try {
      const answered = await store.updateMessageAnswered(
        report.message,
        owner,
        truncateToBytes(report.answer, ANSWER_BYTE_CAP),
        Date.now(),
      );

      if (answered !== null) {
        await recordMessageStatus(e.atcId, answered);
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

    s?.pty?.resize(dims.cols, dims.rows);
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

  const reporter = startHookServer((e) => {
    if (e.event === 'Report') {
      void applyReport(e);

      return;
    }

    const previousAgentSessionID = mgr.sessions.find((s) => s.id === e.atcId)?.agentSessionID;
    const ev = mgr.applyHook(e);

    if (e.event !== 'Statusline') {
      void recordHookEvent(e, ev);
    }

    const kind = ev?.kind ?? null;
    const runtime = runtimes.get(e.atcId);
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
  }, opts.reporterSocketPath);

  const ctx: DaemonContext = {
    build: opts.build,
    collectSessions: () => mgr.collectDescriptors(),
    collectSpawnDirs: () => store.collectSpawnDirs(),
    collectFleet: () => store.loadFleet(),
    loadLastUsedAgent: () => store.loadLastUsedAgent(),
    findAdapter: (kind) => mgr.findAdapter(kind),
    spawnSession: (p) => {
      const s = mgr.spawn(
        p.cwd,
        p.name,
        p.prompt,
        p.cols,
        p.rows,
        p.resume,
        p.namedBy,
        p.agent,
        p.parent,
      );

      const runtime = runtimes.get(s.id);

      if (runtime !== undefined) {
        runtime.pendingLastUsed = true;
        runtime.dims = { cols: p.cols, rows: p.rows };

        runtime.screen = new ScreenModel(p.cols, p.rows);
      }

      void store.recordSpawnDir(p.cwd);

      return getDescriptor(mgr, s.id);
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
      if (!mgr.sessions.some((s) => s.id === id)) {
        return false;
      }

      for (const child of mgr.collectChildren(id)) {
        runtimes.get(child.id)?.stopHeadlessRun();
      }

      runtimes.get(id)?.stopHeadlessRun();

      await mgr.kill(id);

      return true;
    },
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
        startHeadlessTurn: (sid, p) => startHeadlessTurn(mgr, findRuntime, sid, p),
      });

      return 'ok';
    },
    adoptSession: (id, cols, rows) => {
      if (!hasResumableTranscript(mgr, id)) {
        return 'no_transcript';
      }

      const runtime = runtimes.get(id);

      runtime?.stopHeadlessRun();
      const adopted = mgr.adoptTerminal(id, cols, rows);

      if (adopted === null) {
        return 'missing';
      }

      if (runtime !== undefined) {
        runtime.dims = { cols, rows };
        runtime.startedAt = null;
        runtime.tapAttached = false;

        runtime.screen ??= new ScreenModel(cols, rows);
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

      if (s.kind === 'headless') {
        if ((runtimes.get(sessionID)?.headlessRun ?? null) !== null) {
          return 'busy';
        }

        return startHeadlessTurn(mgr, findRuntime, sessionID, data.trimEnd()) ? 'ok' : 'dead';
      }

      if (s.pty === null) {
        return 'dead';
      }

      s.pty.write(data);

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
      restoreFleet({ mgr, store, findRuntime, cols, rows, capMs: opts.restoreBootTimeoutMs ?? 0 }),
    readSessionRecord: async (id) => {
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

      const lastEventAt = await store.loadLastActivityAt(s.id, s.agentSessionID);

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
    readEvents: async (afterID, limit, waitMs) => {
      const deadline = Date.now() + waitMs;

      // A wake for an event the read leaves out (a heartbeat) loops back to
      // wait out the rest of the window.
      for (;;) {
        const generation = eventSignal.generation;

        const rows =
          afterID === null
            ? await store.collectLatestEvents(limit)
            : await store.collectEventsAfter(afterID, limit);

        const remaining = deadline - Date.now();

        if (rows.length > 0 || remaining <= 0 || eventSignal.disposed) {
          return buildFleetEvents(rows, mgr.collectDescriptors());
        }

        await eventSignal.waitForNext(generation, remaining);
      }
    },
    writeSessionMessage: async (sessionID, from, text) => {
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

      const previousWrite = lastMessageWrite;
      const written = Promise.withResolvers<void>();

      lastMessageWrite = written.promise;

      await previousWrite;

      const record: MessageRecord = {
        id: mintMessageID(),
        atcID: sessionID,
        ...(s.agentSessionID === undefined ? {} : { agentSessionID: s.agentSessionID }),
        from,
        text,
        status: 'accepted',
        sentAt: Date.now(),
      };

      try {
        await store.writeMessage(record);

        await recordMessageStatus(sessionID, record);
      } finally {
        written.resolve();
      }

      await drainInbox(sessionID);

      return record;
    },
    attachTap: (client, sessionID) => {
      const s = mgr.sessions.find((x) => x.id === sessionID);

      if (s === undefined) {
        return 'missing';
      }

      if (mgr.findAdapter(s.agent)?.takesMessages !== true) {
        return 'unsupported';
      }

      emitInboxClosed(taps.attach(sessionID, client), sessionID, 'replaced');

      const runtime = runtimes.get(sessionID);

      if (runtime !== undefined) {
        runtime.tapAttached = true;
      }

      void drainInbox(sessionID);

      return 'ok';
    },
    readMessage: async (messageID) => {
      const record = await store.findMessageByID(messageID);

      if (record === null) {
        return null;
      }

      const owner = mgr.sessions.find(
        (x) =>
          x.id === record.atcID ||
          (record.agentSessionID !== undefined && x.agentSessionID === record.agentSessionID),
      );

      return { session: owner?.id ?? record.atcID, record };
    },
    ackMessage: async (client, sessionID, messageID) => {
      const s = mgr.sessions.find((x) => x.id === sessionID);

      if (s === undefined || !taps.isTap(sessionID, client)) {
        return 'not_tapping';
      }

      const owner = buildMessageOwner(s);

      const delivered = await store.updateMessageDelivered(messageID, owner, Date.now());

      void drainInbox(sessionID);

      if (delivered !== null) {
        await recordMessageStatus(sessionID, delivered);

        return delivered;
      }

      const current = await store.findMessage(messageID, owner);

      return current ?? 'unknown';
    },
  };

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
        clients.delete(socket.data);
        ctx.detachClient(socket.data);
        taps.detachAll(socket.data);
      },
      error() {},
    },
  });

  stopDaemon = async () => {
    // Ends each client itself so every peer sees the close: a stopped
    // listener does not reliably end the connections it already accepted.
    for (const client of clients) {
      client.dispose();
    }

    server.stop(true);
    eventsServer?.stop();
    reporter.stop(true);
    mgr.killAll();

    for (const runtime of runtimes.values()) {
      runtime.dispose();
    }

    runtimes.clear();
    eventSignal.dispose();

    await store.stop();

    if (opts.pidPath !== undefined) {
      try {
        unlinkSync(opts.pidPath);
      } catch {}
    }
  };

  return { stop: stopDaemon };
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
