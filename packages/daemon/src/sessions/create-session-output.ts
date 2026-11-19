import type { Clock } from '@atc/core';
import { ansi } from '@atc/core';
import { MAX_CHUNK, PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import type { OutputClient } from '../types';
import { createAttachRegistry } from './create-attach-registry';
import type { Dims } from './create-attach-registry';
import type { SessionManager } from './create-session-manager';
import type { SessionRuntime } from './create-session-runtime';
import { getDescriptor } from './get-descriptor';
import type { HookScope } from './make-hook-runner';
import type { Session } from './session';

const DEFAULT_DIMS: Dims = { cols: 80, rows: 24 };

// Two clients resizing in opposite directions would otherwise send a storm of window-size
// signals to the PTY.
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

  readonly scheduleDetect: (sessionID: SessionID) => void;
}

export interface SessionWatch {
  readonly cols: number;
  readonly rows: number;
  readonly seq: number;
  readonly replay: string;
}

export interface SessionOutput {
  readonly recordOutput: (session: Session, data: string) => void;

  readonly sendReplay: (sessionID: SessionID, client: OutputClient) => Promise<void>;

  readonly attachSession: (
    client: OutputClient,
    sessionID: SessionID,
    dims: Dims,
  ) => 'ok' | 'missing' | 'dead';

  readonly watchSession: (
    client: OutputClient,
    sessionID: SessionID,
  ) => Promise<SessionWatch | 'missing' | 'dead'>;

  readonly detachSession: (client: OutputClient, sessionID: SessionID) => void;
  readonly detachClient: (client: OutputClient) => void;

  readonly updateSessionDims: (client: OutputClient, sessionID: SessionID, dims: Dims) => boolean;

  readonly getEffectiveDims: (sessionID: SessionID) => Dims;

  readonly scheduleResize: (sessionID: SessionID) => void;

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

  const watchers = new Map<SessionID, Set<OutputClient>>();

  const removeWatcher = (sessionID: SessionID, client: OutputClient): boolean => {
    const clients = watchers.get(sessionID);
    const removed = clients?.delete(client) ?? false;

    if (clients !== undefined && clients.size === 0) {
      watchers.delete(sessionID);
    }

    return removed;
  };

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

  // A kill removes the session before the client's connection closes, and the removal was
  // already broadcast, so a detach with no descriptor must emit nothing.
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

    // A replay sent as output has no boundary a watcher could tell from live output, so a watcher
    // must request a fresh watch instead.
    if (runtime === undefined || runtime.screen === null || isWatcher(sessionID, client)) {
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

  const isWatcher = (sessionID: SessionID, client: OutputClient): boolean =>
    !attachments.hasClient(sessionID, client) && (watchers.get(sessionID)?.has(client) ?? false);

  const getEffectiveDims = (sessionID: SessionID): Dims =>
    attachments.findEffectiveDims(sessionID) ?? findRuntime(sessionID)?.dims ?? DEFAULT_DIMS;

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

      const conns = new Set([
        ...attachments.collectClients(session.id),
        ...(watchers.get(session.id) ?? []),
      ]);

      if (conns.size === 0) {
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

    watchSession: async (client, sessionID) => {
      const session = manager.sessions.find((x) => x.id === sessionID);

      if (session === undefined) {
        return 'missing';
      }

      if (session.pty === null) {
        return 'dead';
      }

      manager.requireExecution(session, 'attach');

      // The watcher joins before the capture so output recorded while the capture runs still reaches
      // it.
      const clients = watchers.get(sessionID) ?? new Set<OutputClient>();

      clients.add(client);
      watchers.set(sessionID, clients);

      const runtime = findRuntime(sessionID);
      const screen = runtime?.screen ?? null;

      if (screen === null) {
        const dims = getEffectiveDims(sessionID);

        return { cols: dims.cols, rows: dims.rows, seq: runtime?.seq ?? 0, replay: '' };
      }

      const captured = await screen.captureFullReplay(() => runtime?.seq ?? 0);

      return {
        cols: captured.cols,
        rows: captured.rows,
        seq: captured.mark,
        replay: `${ansi.clear}${captured.replay}`,
      };
    },

    detachSession: (client, sessionID) => {
      removeWatcher(sessionID, client);

      if (!attachments.removeClient(sessionID, client)) {
        return;
      }

      scheduleResize(sessionID);
      emitSessionDetached(sessionID);
    },

    detachClient: (client) => {
      for (const sessionID of watchers.keys()) {
        removeWatcher(sessionID, client);
      }

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

    getEffectiveDims,

    scheduleResize,

    removeSession: (sessionID) => {
      attachments.removeSession(sessionID);
      watchers.delete(sessionID);
    },
  };
}
