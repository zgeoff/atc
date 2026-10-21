import type { Clock, SessionID } from '@atc/core';
import { ansi } from '@atc/core';
import { MAX_CHUNK, PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { OutputClient } from '../daemon-context';
import { createAttachRegistry } from './create-attach-registry';
import type { Dims } from './create-attach-registry';
import type { SessionManager } from './create-session-manager';
import type { SessionRuntime } from './create-session-runtime';
import { getDescriptor } from './get-descriptor';
import type { HookScope } from './make-hook-runner';
import type { Session } from './session';

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

export interface SessionOutput {
  // The screen model consumes every byte continuously: background output
  // is consumed, not discarded.
  readonly recordOutput: (session: Session, data: string) => void;

  // Replay is the serialized screen sent as ordinary output events: the
  // client cannot tell replay from live and does not need to. A clear leads
  // so a stale or desynced client screen resets first.
  readonly sendReplay: (sessionID: SessionID, client: OutputClient) => Promise<void>;

  readonly attachSession: (
    client: OutputClient,
    sessionID: SessionID,
    dims: Dims,
  ) => 'ok' | 'missing' | 'dead';

  readonly detachSession: (client: OutputClient, sessionID: SessionID) => void;
  readonly detachClient: (client: OutputClient) => void;

  // Returns false for a client that is not attached to the session.
  readonly updateSessionDims: (client: OutputClient, sessionID: SessionID, dims: Dims) => boolean;

  readonly getEffectiveDims: (sessionID: SessionID) => Dims;

  // A no-op effective size never reaches the PTY.
  readonly scheduleResize: (sessionID: SessionID) => void;

  // Drops every attachment of a session the manager removed.
  readonly removeSession: (sessionID: SessionID) => void;
}

export function createSessionOutput(deps: SessionOutputDeps): SessionOutput {
  const manager = deps.manager;
  const clock = deps.clock;
  const findRuntime = deps.findRuntime;
  const emitEvent = deps.emitEvent;
  const findHookScope = deps.findHookScope;
  const scheduleDetect = deps.scheduleDetect;
  const attachments = createAttachRegistry<OutputClient>();

  const applyEffectiveDims = (sessionID: SessionID): void => {
    const dims = attachments.findEffectiveDims(sessionID);

    if (dims === null) {
      return;
    }

    const runtime = findRuntime(sessionID);
    const previous = runtime?.dims ?? null;

    if (previous !== null && previous.cols === dims.cols && previous.rows === dims.rows) {
      return;
    }

    const session = manager.sessions.find((x) => x.id === sessionID);

    // A host that cannot resize keeps its terminal at the size it started
    // with; the screen model still follows the clients.
    if (session !== undefined && (manager.findProvider(session)?.capabilities.resize ?? false)) {
      session.pty?.resize(dims.cols, dims.rows);
    }

    runtime?.screen?.updateDims(dims.cols, dims.rows);

    if (runtime !== undefined) {
      runtime.dims = dims;
    }

    emitEvent(
      {
        version: PROTOCOL_V,
        ev: 'SessionResized',
        sessionID,
        cols: dims.cols,
        rows: dims.rows,
      },
      findHookScope(sessionID),
    );
  };

  // A detach can outlive its session (a kill removes the session before the
  // client's connection closes), and a gone session already broadcast its
  // removal, so a descriptor miss emits nothing.
  const emitSessionDetached = (sessionID: SessionID): void => {
    const session = manager.collectDescriptors().find((x) => x.id === sessionID);

    if (session !== undefined) {
      emitEvent(
        { version: PROTOCOL_V, ev: 'SessionDetached', session },
        { cwd: session.cwd, repoRoot: session.repoRoot },
      );
    }
  };

  const sendReplay = async (sessionID: SessionID, client: OutputClient): Promise<void> => {
    const runtime = findRuntime(sessionID);

    if (runtime === undefined || runtime.screen === null) {
      return;
    }

    const replay = `${ansi.clear}${await runtime.screen.captureReplay()}`;
    const seq = runtime.seq;

    for (let offset = 0; offset < replay.length; offset += MAX_CHUNK) {
      const chunk = replay.slice(offset, offset + MAX_CHUNK);

      client.sendOutput(
        sessionID,
        { version: PROTOCOL_V, ev: 'SessionOutput', sessionID, seq, data: chunk },
        chunk.length,
      );
    }
  };

  const scheduleResize = (sessionID: SessionID): void => {
    const runtime = findRuntime(sessionID);

    if (runtime === undefined || runtime.cancelResize !== undefined) {
      return;
    }

    runtime.cancelResize = clock.schedule(() => {
      runtime.cancelResize = undefined;

      applyEffectiveDims(sessionID);
    }, RESIZE_DEBOUNCE_MS);
  };

  return {
    recordOutput: (session, data) => {
      const runtime = findRuntime(session.id);

      runtime?.screen?.record(data);
      scheduleDetect(session.id);

      if (runtime !== undefined) {
        runtime.lastOutputAt = clock.now();
      }

      const conns = attachments.collectClients(session.id);

      if (conns.length === 0) {
        return;
      }

      let seq = runtime?.seq ?? 0;

      for (let offset = 0; offset < data.length; offset += MAX_CHUNK) {
        const chunk = data.slice(offset, offset + MAX_CHUNK);

        seq++;

        const event: EventMsg = {
          version: PROTOCOL_V,
          ev: 'SessionOutput',
          sessionID: session.id,
          seq,
          data: chunk,
        };

        for (const conn of conns) {
          conn.sendOutput(session.id, event, chunk.length);
        }
      }

      if (runtime !== undefined) {
        runtime.seq = seq;
      }
    },

    sendReplay,

    attachSession: (client, sessionID, dims) => {
      const session = manager.sessions.find((x) => x.id === sessionID);

      if (session === undefined) {
        return 'missing';
      }

      if (session.pty === null) {
        return 'dead';
      }

      manager.requireExecution(session, 'attach');
      attachments.attach(sessionID, client, dims);
      manager.attach(sessionID);

      // resize before the replay renders: a replay at the previous attachment's
      // dims paints misaligned, and the agent's resize repaint only redraws its
      // live region, never the rows above it
      applyEffectiveDims(sessionID);
      void sendReplay(sessionID, client);
      const attached = getDescriptor(manager, sessionID);

      emitEvent(
        { version: PROTOCOL_V, ev: 'SessionAttached', session: attached },
        { cwd: attached.cwd, repoRoot: attached.repoRoot },
      );

      return 'ok';
    },

    detachSession: (client, sessionID) => {
      if (!attachments.removeClient(sessionID, client)) {
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

    updateSessionDims: (client, sessionID, dims) => {
      if (!attachments.updateDims(sessionID, client, dims)) {
        return false;
      }

      scheduleResize(sessionID);

      return true;
    },

    getEffectiveDims: (sessionID) =>
      attachments.findEffectiveDims(sessionID) ?? findRuntime(sessionID)?.dims ?? DEFAULT_DIMS,

    scheduleResize,

    removeSession: (sessionID) => {
      attachments.removeSession(sessionID);
    },
  };
}
