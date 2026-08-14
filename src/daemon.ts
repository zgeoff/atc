import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AgentAdapter } from './agent-adapter';
import { AttachRegistry } from './attach-registry';
import type { Dims } from './attach-registry';
import { DaemonConnection } from './daemon-connection';
import type { DaemonContext, OutputClient } from './daemon-connection';
import { startHookServer } from './hooks';
import { PermissionRegistry } from './permission-registry';
import { MAX_CHUNK, PROTOCOL_V } from './protocol';
import type { EventMsg } from './protocol';
import { ScreenModel } from './screen-model';
import { SessionManager } from './sessions';
import type { Session, SessionDescriptor, SessionState } from './sessions';
import { StateStore } from './state-store';

export interface DaemonOptions {
  readonly socketPath: string;
  readonly reporterSocketPath: string;

  // Build string sent in the handshake and in mismatch errors, e.g. "atc/0.1.0".
  readonly build: string;
  readonly adapter: AgentAdapter;

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

  // Runs one headless turn over a session; the real one drives the Agent
  // SDK, which spawns real claude — a boundary tests never cross. Absent
  // means eject is unsupported.
  readonly headlessRunner?: HeadlessRunner;

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

interface HeadlessRunRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly resume?: string;
  readonly permissionMode?: string;
}

interface HeadlessRunEvents {
  readonly onOutput: (text: string) => void;
  readonly onDone: (summary: string) => void;
  readonly onNeedsYou: (msg: string) => void;
}

export type HeadlessRunner = (
  opts: HeadlessRunRequest,
  hooks: HeadlessRunEvents,
) => { readonly stop: () => void };

export interface DaemonHandle {
  readonly stop: () => void;
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
export function startDaemon(opts: DaemonOptions): DaemonHandle {
  let stopDaemon: (() => void) | null = null;

  if (opts.pidPath !== undefined) {
    writeFileSync(opts.pidPath, String(process.pid));
  }

  const store = new StateStore(opts.dbPath, opts.legacyFleetPath);

  const mgr =
    opts.statusPath === undefined
      ? new SessionManager(opts.adapter, store)
      : new SessionManager(opts.adapter, store, opts.statusPath);

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

  const headlessRuns = new Map<string, { readonly stop: () => void }>();

  // Resuming an agent session while its old process is still shutting down
  // corrupts the handoff, so an eject waits for the terminal's final report
  // (or a settle timeout) before the headless run starts.
  const pendingEjects = new Map<string, () => void>();

  // A staggered fleet restore parks a resolver here while it waits for the
  // session it just revived to report it has booted; the reporter fires it on
  // SessionStart, and a dying revive fires it too so a failed resume does not
  // hold up the rest. Resolving a settled promise again is a no-op.
  const bootWaiters = new Map<string, () => void>();

  // Blocks until the session reports SessionStart, it dies, or the cap
  // elapses (a positive cap only; zero waits on the signal alone).
  const waitForBoot = (sessionID: string, capMs: number): Promise<void> => {
    const settled = Promise.withResolvers<void>();
    const timer = capMs > 0 ? setTimeout(settled.resolve, capMs) : undefined;

    bootWaiters.set(sessionID, settled.resolve);

    if (timer !== undefined) {
      restoreTimers.add(timer);
    }

    return (async () => {
      await settled.promise;

      bootWaiters.delete(sessionID);

      if (timer !== undefined) {
        clearTimeout(timer);

        restoreTimers.delete(timer);
      }
    })();
  };

  const startHeadlessTurn = (sessionID: string, prompt: string): boolean => {
    const runner = opts.headlessRunner;
    const s = mgr.sessions.find((x) => x.id === sessionID);

    if (runner === undefined || s === undefined || headlessRuns.has(sessionID)) {
      return false;
    }

    mgr.updateSurfaceState(sessionID, 'running', 'headless turn running');

    const handle = runner(
      {
        cwd: s.cwd,
        prompt,
        ...(s.claudeId === undefined ? {} : { resume: s.claudeId }),
        permissionMode: 'auto',
      },
      {
        onOutput: (text) => {
          mgr.onOutput(s, text);
        },
        onDone: (summary) => {
          headlessRuns.delete(sessionID);

          const doneMsg = summary === '' ? 'headless turn done' : summary;

          mgr.updateSurfaceState(sessionID, 'done', doneMsg);
        },
        onNeedsYou: (msg) => {
          headlessRuns.delete(sessionID);
          mgr.updateSurfaceState(sessionID, 'needs_you', msg);
        },
      },
    );

    headlessRuns.set(sessionID, handle);

    return true;
  };

  const attachments = new AttachRegistry<OutputClient>();
  const seqs = new Map<string, number>();
  const ptyDims = new Map<string, Dims>();
  const screens = new Map<string, ScreenModel>();
  const resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const detectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const restoreTimers = new Set<ReturnType<typeof setTimeout>>();

  // The screen tier of the detector stack: once a session's output has
  // quiesced, judge the serialized screen and flip running/needs_you.
  const scheduleDetect = (sessionID: string) => {
    const detector = opts.adapter.screenDetector;

    if (detector === null) {
      return;
    }

    const pending = detectTimers.get(sessionID);

    if (pending !== undefined) {
      clearTimeout(pending);
    }

    detectTimers.set(
      sessionID,
      setTimeout(() => {
        detectTimers.delete(sessionID);
        void applyScreenJudgment(sessionID);
      }, 300),
    );
  };

  // Replay is the serialized screen sent as ordinary output events: the
  // client cannot tell replay from live and does not need to. A clear leads
  // so a stale or desynced client screen resets first.
  const sendReplay = async (sessionID: string, client: OutputClient) => {
    const model = screens.get(sessionID);

    if (model === undefined) {
      return;
    }

    const replay = `\u001B[2J\u001B[H${await model.renderReplay()}`;
    const seq = seqs.get(sessionID) ?? 0;

    for (let i = 0; i < replay.length; i += MAX_CHUNK) {
      const chunk = replay.slice(i, i + MAX_CHUNK);

      client.sendOutput(
        sessionID,
        { v: PROTOCOL_V, ev: 'session.output', s: sessionID, seq, d: chunk },
        chunk.length,
      );
    }
  };

  const applyEffectiveDims = (sessionID: string) => {
    const dims = attachments.findEffectiveDims(sessionID);

    if (dims === null) {
      return;
    }

    const prev = ptyDims.get(sessionID);

    if (prev !== undefined && prev.cols === dims.cols && prev.rows === dims.rows) {
      return;
    }

    const s = mgr.sessions.find((x) => x.id === sessionID);

    s?.pty?.resize(dims.cols, dims.rows);
    screens.get(sessionID)?.updateDims(dims.cols, dims.rows);
    ptyDims.set(sessionID, dims);

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
  const scheduleResize = (sessionID: string) => {
    if (resizeTimers.has(sessionID)) {
      return;
    }

    resizeTimers.set(
      sessionID,
      setTimeout(() => {
        resizeTimers.delete(sessionID);

        applyEffectiveDims(sessionID);
      }, 50),
    );
  };

  const applyScreenJudgment = async (sessionID: string) => {
    const detector = opts.adapter.screenDetector;
    const model = screens.get(sessionID);

    if (detector === null || model === undefined) {
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
    // The screen model consumes every byte continuously — background output
    // is consumed, not discarded.
    screens.get(s.id)?.record(data);
    scheduleDetect(s.id);

    const conns = attachments.collectClients(s.id);

    if (conns.length === 0) {
      return;
    }

    let seq = seqs.get(s.id) ?? 0;

    for (let i = 0; i < data.length; i += MAX_CHUNK) {
      const chunk = data.slice(i, i + MAX_CHUNK);

      seq++;

      const event: EventMsg = { v: PROTOCOL_V, ev: 'session.output', s: s.id, seq, d: chunk };

      for (const conn of conns) {
        conn.sendOutput(s.id, event, chunk.length);
      }
    }

    seqs.set(s.id, seq);
  };

  // Permission requests are synthesized from attention transitions: entering
  // needs_you opens one, and leaving it (answered directly in the terminal,
  // or the session dying) dismisses whatever is pending.
  const lastStates = new Map<string, SessionState>();

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

    // A revive that dies before it ever announces itself must still release
    // the staggered restore, or a failed resume would hold up the fleet.
    if (kind === 'removed' || (kind === 'state' && s.pty === null)) {
      bootWaiters.get(s.id)?.();
    }

    if (kind === 'removed') {
      attachments.removeSession(s.id);
      seqs.delete(s.id);
      ptyDims.delete(s.id);
      screens.get(s.id)?.stop();
      screens.delete(s.id);

      const pendingDetect = detectTimers.get(s.id);

      if (pendingDetect !== undefined) {
        clearTimeout(pendingDetect);

        detectTimers.delete(s.id);
      }
    }

    const builders: Record<typeof kind, () => EventMsg> = {
      added: () => ({ v: PROTOCOL_V, ev: 'session.added', session: getDescriptor(mgr, s.id) }),
      state: () => ({
        v: PROTOCOL_V,
        ev: 'session.state',
        s: s.id,
        state: s.state,
        unread: s.unread,
        lastMsg: s.lastMsg,
        kind: s.kind,
        alive: s.pty !== null || (s.kind === 'jsonl' && s.state !== 'exited'),
        ...(s.claudeId === undefined ? {} : { claudeId: s.claudeId }),
        ...(s.group === undefined ? {} : { group: s.group }),
      }),
      renamed: () => ({
        v: PROTOCOL_V,
        ev: 'session.renamed',
        s: s.id,
        name: s.name,
        namedBy: s.namedBy,
      }),
      removed: () => ({ v: PROTOCOL_V, ev: 'session.removed', s: s.id }),
    };

    emitEvent(builders[kind]());
  };

  const reporter = startHookServer((e) => {
    if (e.event !== 'Statusline') {
      store.recordEvent(e);
    }

    if (e.event === 'SessionEnd') {
      pendingEjects.get(e.atcId)?.();
    }

    // A revived session announcing itself is the cue a staggered restore
    // waits on before booting the next one.
    if (e.event === 'SessionStart') {
      bootWaiters.get(e.atcId)?.();
    }

    mgr.applyHook(e);
  }, opts.reporterSocketPath);

  const ctx: DaemonContext = {
    build: opts.build,
    collectSessions: () => mgr.collectDescriptors(),
    collectSpawnDirs: () => store.collectSpawnDirs(),
    collectFleet: () => store.loadFleet(),
    spawnSession: (p) => {
      const s = mgr.spawn(p.cwd, p.name, p.prompt, p.cols, p.rows, p.resume, p.namedBy, p.group);

      ptyDims.set(s.id, { cols: p.cols, rows: p.rows });
      screens.set(s.id, new ScreenModel(p.cols, p.rows));
      store.recordSpawnDir(p.cwd);

      return getDescriptor(mgr, s.id);
    },
    updateSession: (id, name, group) => mgr.updateSession(id, name, group),
    quitDaemon: () => {
      // The ok response for the quit request must flush before the sockets
      // close under it.
      setTimeout(() => {
        stopDaemon?.();
        opts.onQuit?.();
      }, 80);
    },
    killSession: (id) => {
      if (!mgr.sessions.some((s) => s.id === id)) {
        return false;
      }

      headlessRuns.get(id)?.stop();
      headlessRuns.delete(id);
      mgr.kill(id);

      return true;
    },
    ejectSession: (id, prompt) => {
      if (opts.headlessRunner === undefined) {
        return 'unsupported';
      }

      if (!hasResumableTranscript(mgr, id)) {
        return 'no_transcript';
      }

      const yanked = mgr.yankHeadless(id);

      if (yanked === null) {
        return 'missing';
      }

      const settled = Promise.withResolvers<void>();
      const timer = setTimeout(settled.resolve, opts.ejectSettleMs ?? 4000);

      pendingEjects.set(id, settled.resolve);

      void (async () => {
        await settled.promise;

        clearTimeout(timer);

        pendingEjects.delete(id);

        startHeadlessTurn(id, prompt);
      })();

      return 'ok';
    },
    adoptSession: (id, cols, rows) => {
      if (!hasResumableTranscript(mgr, id)) {
        return 'no_transcript';
      }

      headlessRuns.get(id)?.stop();
      headlessRuns.delete(id);

      const adopted = mgr.adoptTerminal(id, cols, rows);

      if (adopted === null) {
        return 'missing';
      }

      ptyDims.set(id, { cols, rows });

      if (!screens.has(id)) {
        screens.set(id, new ScreenModel(cols, rows));
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

      if (s.kind === 'jsonl') {
        if (headlessRuns.has(sessionID)) {
          return 'busy';
        }

        return startHeadlessTurn(sessionID, data.trimEnd()) ? 'ok' : 'dead';
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
      attachments.findEffectiveDims(sessionID) ?? ptyDims.get(sessionID) ?? { cols: 80, rows: 24 },
    restoreFleet: (cols, rows) => {
      const hasSession = (claudeId: string) =>
        mgr.sessions.some(
          (s) =>
            s.claudeId === claudeId &&
            (s.pty !== null || (s.kind === 'jsonl' && s.state !== 'exited')),
        );

      const recency = store.collectFleetRecency();

      // Most recently active sessions revive first, so the ones the user was
      // just working in come back before long-idle ones; entries that never
      // reported an event keep their stored order at the end.
      const entries = store
        .loadFleet()
        .filter((entry) => !hasSession(entry.claudeId))
        .toSorted((a, b) =>
          (recency.get(b.claudeId) ?? '').localeCompare(recency.get(a.claudeId) ?? ''),
        );

      // The whole fleet registers as terminal-less sessions up front, so the
      // list shows every incoming session immediately instead of revealing
      // them one boot at a time.
      const queued = entries.map((entry) => mgr.restore(entry));

      const adoptQueued = (s: Session): boolean => {
        if (mgr.adoptTerminal(s.id, cols, rows) === null) {
          return false;
        }

        ptyDims.set(s.id, { cols, rows });

        if (!screens.has(s.id)) {
          screens.set(s.id, new ScreenModel(cols, rows));
        }

        return true;
      };

      const [first, ...rest] = queued;

      if (first === undefined) {
        return 0;
      }

      // The first terminal attaches synchronously so a caller can attach at
      // once; each later one waits for the previous session to report it has
      // booted, so a heavy fleet comes up one process at a time instead of
      // all at once. A per-session cap keeps a session that never reports
      // from stalling the rest.
      const cap = opts.restoreBootTimeoutMs ?? 0;

      const adoptRest = async (previous: Session | null) => {
        let prev = previous;

        for (const s of rest) {
          if (prev !== null) {
            await waitForBoot(prev.id, cap);
          }

          prev = adoptQueued(s) ? s : null;
        }
      };

      const firstBooted = adoptQueued(first) ? first : null;

      void adoptRest(firstBooted);

      return queued.length;
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

  stopDaemon = () => {
    for (const timer of resizeTimers.values()) {
      clearTimeout(timer);
    }

    for (const timer of detectTimers.values()) {
      clearTimeout(timer);
    }

    for (const timer of restoreTimers) {
      clearTimeout(timer);
    }

    server.stop(true);
    reporter.stop(true);
    mgr.killAll();

    for (const model of screens.values()) {
      model.stop();
    }

    store.stop();

    if (opts.pidPath !== undefined) {
      try {
        unlinkSync(opts.pidPath);
      } catch {}
    }
  };

  return { stop: stopDaemon };
}

// A session reporting a transcript path that does not exist on disk yet has
// nothing to resume — claude exits immediately on such a resume, which
// reads as the revive silently failing. A session that never reported a
// path (foreign adapters) passes; the spawn itself will tell the truth.
function hasResumableTranscript(mgr: SessionManager, id: string): boolean {
  const s = mgr.sessions.find((x) => x.id === id);

  if (s === undefined || s.transcriptSource === undefined) {
    return true;
  }

  return existsSync(s.transcriptSource);
}

function getDescriptor(mgr: SessionManager, id: string): SessionDescriptor {
  const d = mgr.collectDescriptors().find((x) => x.id === id);

  if (d === undefined) {
    throw new Error(`descriptor for unknown session ${id}`);
  }

  return d;
}
