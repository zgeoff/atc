import { unlinkSync, writeFileSync } from 'node:fs';
import type { AgentAdapter } from './agent-adapter';
import { AttachRegistry } from './attach-registry';
import { buildSessionEvent } from './build-session-event';
import { DaemonConnection } from './daemon-connection';
import type { DaemonContext, OutputClient } from './daemon-connection';
import { startHookServer } from './hooks';
import { PermissionRegistry } from './permission-registry';
import { MAX_CHUNK, PROTOCOL_V } from './protocol';
import type { EventMsg } from './protocol';
import { restoreFleet } from './restore-fleet';
import { runEjectHandoff } from './run-eject-handoff';
import { ScreenModel } from './screen-model';
import type { SessionID } from './session-id';
import { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';
import type { SessionDescriptor, SessionState } from './sessions';
import { startHeadlessTurn } from './start-headless-turn';
import { StateStore } from './state-store';

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

  // Called after a client-requested quit has stopped the daemon; the real
  // entrypoint exits the process, tests leave it unset.
  readonly onQuit?: () => void;
}

export interface DaemonHandle {
  readonly stop: () => Promise<void>;
}

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

  const emitEvent = (event: EventMsg) => {
    for (const client of clients) {
      client.sendEvent(event);
    }
  };

  const registry = new PermissionRegistry();

  registry.onRequested = (req) => {
    emitEvent({
      v: PROTOCOL_V,
      ev: 'permission.requested',
      request: req.id,
      s: req.sessionID,
      message: req.message,
      respondable: req.respondable,
    });
  };

  registry.onResolved = (id, decision) => {
    emitEvent({ v: PROTOCOL_V, ev: 'permission.resolved', request: id, decision });
  };

  // One runtime per live session: its screen model, output sequence
  // counter, PTY dims, its resize/detect/boot timers, its live headless
  // run, and its pending eject and boot waiters. Created when the session
  // manager announces the session and disposed the moment it is removed, so
  // removal is always a single lookup plus dispose.
  const runtimes = new Map<SessionID, SessionRuntime>();

  const findRuntime = (sessionID: SessionID) => runtimes.get(sessionID);

  const attachments = new AttachRegistry<OutputClient>();

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
        { v: PROTOCOL_V, ev: 'session.output', s: sessionID, seq, d: chunk },
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

    emitEvent({
      v: PROTOCOL_V,
      ev: 'session.resized',
      s: sessionID,
      cols: dims.cols,
      rows: dims.rows,
    });
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

      const event: EventMsg = { v: PROTOCOL_V, ev: 'session.output', s: s.id, seq, d: chunk };

      for (const conn of conns) {
        conn.sendOutput(s.id, event, chunk.length);
      }
    }

    if (runtime !== undefined) {
      runtime.seq = seq;
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
      runtimes.get(s.id)?.dispose();
      runtimes.delete(s.id);
    }

    const event = buildSessionEvent(mgr, kind, s);

    if (event !== null) {
      emitEvent(event);
    }
  };

  const reporter = startHookServer((e) => {
    if (e.event !== 'Statusline') {
      void store.recordEvent(e);
    }

    const kind = mgr.applyHook(e);
    const runtime = runtimes.get(e.atcId);

    if (kind === 'ended') {
      runtime?.pendingEject?.();
    }

    // A revived session announcing itself is the cue a staggered restore
    // waits on before booting the next one.
    if (kind === 'started') {
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
      const s = mgr.spawn(p.cwd, p.name, p.prompt, p.cols, p.rows, p.resume, p.namedBy, p.agent);
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

      scheduleResize(sessionID);
      void sendReplay(sessionID, client);

      return 'ok';
    },
    detachSession: (client, sessionID) => {
      attachments.detach(sessionID, client);

      scheduleResize(sessionID);
    },
    detachClient: (client) => {
      for (const sessionID of attachments.detachAll(client)) {
        scheduleResize(sessionID);
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
        socket.data.applyChunk(buf.toString());
      },
      drain(socket) {
        socket.data.drain();
      },
      close(socket) {
        clients.delete(socket.data);
        ctx.detachClient(socket.data);
      },
      error() {},
    },
  });

  stopDaemon = async () => {
    server.stop(true);
    reporter.stop(true);
    mgr.killAll();

    for (const runtime of runtimes.values()) {
      runtime.dispose();
    }

    runtimes.clear();

    await store.stop();

    if (opts.pidPath !== undefined) {
      try {
        unlinkSync(opts.pidPath);
      } catch {}
    }
  };

  return { stop: stopDaemon };
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
