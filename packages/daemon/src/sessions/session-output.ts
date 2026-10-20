import type { Clock, SessionID } from '@atc/core';
import { ansi } from '@atc/core';
import { MAX_CHUNK, PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { OutputClient } from '../daemon-context';
import { AttachRegistry } from './attach-registry';
import type { Dims } from './attach-registry';
import { getDescriptor } from './get-descriptor';
import type { HookScope } from './make-hook-runner';
import type { Session } from './session';
import type { SessionRuntime } from './session-runtime';
import type { SessionManager } from './sessions';

// The size a session's terminal is read at before any client attaches and
// before its harness reports one.
const DEFAULT_DIMS: Dims = { cols: 80, rows: 24 };

// How long a resize waits for more, so two clients resizing in opposite
// directions cannot produce a storm of window-size signals.
const RESIZE_DEBOUNCE_MS = 50;

interface SessionOutputDeps {
  readonly manager: Pick<
    SessionManager,
    'sessions' | 'collectDescriptors' | 'findProvider' | 'requireExecution' | 'attach'
  >;
  readonly clock: Clock;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;
  readonly emitEvent: (event: EventMsg, scope: HookScope | null) => void;
  readonly findHookScope: (sessionID: SessionID) => HookScope | null;

  // Starts the wait before the session's screen is judged for attention.
  readonly scheduleDetect: (sessionID: SessionID) => void;
}

export class SessionOutput {
  private readonly manager: SessionOutputDeps['manager'];

  private readonly clock: Clock;

  private readonly findRuntime: SessionOutputDeps['findRuntime'];

  private readonly emitEvent: SessionOutputDeps['emitEvent'];

  private readonly findHookScope: SessionOutputDeps['findHookScope'];

  private readonly scheduleDetect: SessionOutputDeps['scheduleDetect'];

  private readonly attachments = new AttachRegistry<OutputClient>();

  constructor(deps: SessionOutputDeps) {
    this.manager = deps.manager;
    this.clock = deps.clock;
    this.findRuntime = deps.findRuntime;
    this.emitEvent = deps.emitEvent;
    this.findHookScope = deps.findHookScope;
    this.scheduleDetect = deps.scheduleDetect;
  }

  // The screen model consumes every byte continuously: background output
  // is consumed, not discarded.
  recordOutput(session: Session, data: string): void {
    const runtime = this.findRuntime(session.id);

    runtime?.screen?.record(data);
    this.scheduleDetect(session.id);

    if (runtime !== undefined) {
      runtime.lastOutputAt = this.clock.now();
    }

    const conns = this.attachments.collectClients(session.id);

    if (conns.length === 0) {
      return;
    }

    let seq = runtime?.seq ?? 0;

    for (let offset = 0; offset < data.length; offset += MAX_CHUNK) {
      const chunk = data.slice(offset, offset + MAX_CHUNK);

      seq++;

      const event: EventMsg = { v: PROTOCOL_V, ev: 'SessionOutput', s: session.id, seq, d: chunk };

      for (const conn of conns) {
        conn.sendOutput(session.id, event, chunk.length);
      }
    }

    if (runtime !== undefined) {
      runtime.seq = seq;
    }
  }

  // Replay is the serialized screen sent as ordinary output events: the
  // client cannot tell replay from live and does not need to. A clear leads
  // so a stale or desynced client screen resets first.
  async sendReplay(sessionID: SessionID, client: OutputClient): Promise<void> {
    const runtime = this.findRuntime(sessionID);

    if (runtime === undefined || runtime.screen === null) {
      return;
    }

    const replay = `${ansi.clear}${await runtime.screen.captureReplay()}`;
    const seq = runtime.seq;

    for (let offset = 0; offset < replay.length; offset += MAX_CHUNK) {
      const chunk = replay.slice(offset, offset + MAX_CHUNK);

      client.sendOutput(
        sessionID,
        { v: PROTOCOL_V, ev: 'SessionOutput', s: sessionID, seq, d: chunk },
        chunk.length,
      );
    }
  }

  attachSession(client: OutputClient, sessionID: SessionID, dims: Dims): 'ok' | 'missing' | 'dead' {
    const session = this.manager.sessions.find((x) => x.id === sessionID);

    if (session === undefined) {
      return 'missing';
    }

    if (session.pty === null) {
      return 'dead';
    }

    this.manager.requireExecution(session, 'attach');
    this.attachments.attach(sessionID, client, dims);
    this.manager.attach(sessionID);

    // resize before the replay renders: a replay at the previous attachment's
    // dims paints misaligned, and the agent's resize repaint only redraws its
    // live region, never the rows above it
    this.applyEffectiveDims(sessionID);
    void this.sendReplay(sessionID, client);
    const attached = getDescriptor(this.manager, sessionID);

    this.emitEvent(
      { v: PROTOCOL_V, ev: 'SessionAttached', session: attached },
      { cwd: attached.cwd, repoRoot: attached.repoRoot },
    );

    return 'ok';
  }

  detachSession(client: OutputClient, sessionID: SessionID): void {
    if (!this.attachments.removeClient(sessionID, client)) {
      return;
    }

    this.scheduleResize(sessionID);
    this.emitSessionDetached(sessionID);
  }

  detachClient(client: OutputClient): void {
    for (const sessionID of this.attachments.detachAll(client)) {
      this.scheduleResize(sessionID);
      this.emitSessionDetached(sessionID);
    }
  }

  // Returns false for a client that is not attached to the session.
  updateSessionDims(client: OutputClient, sessionID: SessionID, dims: Dims): boolean {
    if (!this.attachments.updateDims(sessionID, client, dims)) {
      return false;
    }

    this.scheduleResize(sessionID);

    return true;
  }

  getEffectiveDims(sessionID: SessionID): Dims {
    return (
      this.attachments.findEffectiveDims(sessionID) ??
      this.findRuntime(sessionID)?.dims ??
      DEFAULT_DIMS
    );
  }

  // A no-op effective size never reaches the PTY.
  scheduleResize(sessionID: SessionID): void {
    const runtime = this.findRuntime(sessionID);

    if (runtime === undefined || runtime.cancelResize !== undefined) {
      return;
    }

    runtime.cancelResize = this.clock.schedule(() => {
      runtime.cancelResize = undefined;

      this.applyEffectiveDims(sessionID);
    }, RESIZE_DEBOUNCE_MS);
  }

  // Drops every attachment of a session the manager removed.
  removeSession(sessionID: SessionID): void {
    this.attachments.removeSession(sessionID);
  }

  private applyEffectiveDims(sessionID: SessionID): void {
    const dims = this.attachments.findEffectiveDims(sessionID);

    if (dims === null) {
      return;
    }

    const runtime = this.findRuntime(sessionID);
    const previous = runtime?.dims ?? null;

    if (previous !== null && previous.cols === dims.cols && previous.rows === dims.rows) {
      return;
    }

    const session = this.manager.sessions.find((x) => x.id === sessionID);

    // A host that cannot resize keeps its terminal at the size it started
    // with; the screen model still follows the clients.
    if (
      session !== undefined &&
      (this.manager.findProvider(session)?.capabilities.resize ?? false)
    ) {
      session.pty?.resize(dims.cols, dims.rows);
    }

    runtime?.screen?.updateDims(dims.cols, dims.rows);

    if (runtime !== undefined) {
      runtime.dims = dims;
    }

    this.emitEvent(
      {
        v: PROTOCOL_V,
        ev: 'SessionResized',
        s: sessionID,
        cols: dims.cols,
        rows: dims.rows,
      },
      this.findHookScope(sessionID),
    );
  }

  // A detach can outlive its session (a kill removes the session before the
  // client's connection closes), and a gone session already broadcast its
  // removal, so a descriptor miss emits nothing.
  private emitSessionDetached(sessionID: SessionID): void {
    const session = this.manager.collectDescriptors().find((x) => x.id === sessionID);

    if (session !== undefined) {
      this.emitEvent(
        { v: PROTOCOL_V, ev: 'SessionDetached', session },
        { cwd: session.cwd, repoRoot: session.repoRoot },
      );
    }
  }
}
