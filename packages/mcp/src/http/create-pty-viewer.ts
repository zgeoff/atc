import type { DaemonEvent, SessionDescriptor } from '@atcx/contract';
import { P, match } from 'ts-pattern';
import { createActor } from 'xstate';
import type { z } from 'zod';
import { PTY_VIEWER_MACHINE } from './pty-viewer-machine';
import { WATCH_ANSWER_SCHEMA } from './watch-answer-schema';

// The daemon connection one viewer reads. Each viewer has its own, so a
// viewer that lags holds back no other client.
export interface WatchChannel {
  onEvent: (event: DaemonEvent) => void;
  onClose: () => void;
  readonly sendRequest: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly stop: () => void;
}

// The browser's WebSocket, as the viewer writes to it.
export interface PTYSocket {
  readonly send: (frame: string | Uint8Array) => void;
  readonly getBufferedAmount: () => number;
  readonly close: (code: number, reason: string) => void;
}

// A session's screen as a watch answers with it, and the session's state.
export interface PTYSnapshot {
  readonly cols: number;
  readonly rows: number;
  readonly seq: number;
  readonly replay: string;
  readonly state: SessionDescriptor['state'];
}

export interface PTYViewer {
  // Sends the first snapshot and the output held since it was taken.
  readonly open: (socket: PTYSocket) => void;
  readonly drain: () => void;

  // Ends the viewer's daemon connection once the browser closes the socket.
  readonly close: () => void;
}

interface PTYViewerOptions {
  readonly sessionID: string;
  readonly channel: WatchChannel;
  readonly first: PTYSnapshot;

  // How many bytes the socket may hold unsent before the viewer drops output
  // and sends a fresh snapshot once the socket drains.
  readonly maxBufferedBytes: number;
}

// Why a viewer's stream ended, as its closed frame says.
type ClosedReason = 'exited' | 'removed' | 'daemon_closed' | 'unavailable';

// A WebSocket close code for a stream that ended as it should.
const NORMAL_CLOSURE = 1000;

export function createPTYViewer(options: PTYViewerOptions): PTYViewer {
  const sessionID = options.sessionID;
  const channel = options.channel;
  const actor = createActor(PTY_VIEWER_MACHINE).start();

  const encoder = new TextEncoder();

  let socket: PTYSocket | null = null;
  let pending: PTYSnapshot = options.first;
  let lastSeq = 0;
  let closedReason: ClosedReason | null = null;

  // The output that arrived while no snapshot had gone out yet; a snapshot
  // already holds what is at or below its own sequence.
  const held: { seq: number; data: string }[] = [];
  let heldBytes = 0;

  const isIn = (state: 'opening' | 'streaming' | 'stalled' | 'resyncing' | 'closed'): boolean =>
    actor.getSnapshot().matches(state);

  const sendControl = (frame: Readonly<Record<string, unknown>>): void => {
    socket?.send(JSON.stringify(frame));
  };

  const sendClosed = (reason: ClosedReason): void => {
    sendControl({ type: 'closed', reason });
    socket?.close(NORMAL_CLOSURE, reason);
  };

  const finish = (reason: ClosedReason): void => {
    if (isIn('closed')) {
      return;
    }

    actor.send({ type: 'CLOSE' });

    closedReason = reason;

    sendClosed(reason);

    channel.stop();
  };

  const sendOutput = (seq: number, data: string): void => {
    if (seq <= lastSeq) {
      return;
    }

    if (seq > lastSeq + 1) {
      resync();

      return;
    }

    if (socket === null || socket.getBufferedAmount() > options.maxBufferedBytes) {
      actor.send({ type: 'STALL' });

      return;
    }

    socket.send(encoder.encode(data));

    lastSeq = seq;
  };

  const sendSnapshot = (snapshot: PTYSnapshot): void => {
    sendControl({
      type: 'snapshot',
      cols: snapshot.cols,
      rows: snapshot.rows,
      seq: snapshot.seq,
      state: snapshot.state,
      data: snapshot.replay,
    });

    lastSeq = snapshot.seq;

    const later = held.splice(0);

    heldBytes = 0;

    for (const output of later) {
      if (!isIn('streaming')) {
        return;
      }

      sendOutput(output.seq, output.data);
    }
  };

  const requestSnapshot = async (): Promise<void> => {
    let answer: z.infer<typeof WATCH_ANSWER_SCHEMA>;

    try {
      const watched = await channel.sendRequest('session.watch', { session: sessionID });

      answer = WATCH_ANSWER_SCHEMA.parse(watched);
    } catch {
      finish('unavailable');

      return;
    }

    // A stall or a close while the answer was on its way drops it; a drain
    // asks again.
    if (!isIn('resyncing')) {
      return;
    }

    actor.send({ type: 'SNAPSHOT' });

    sendSnapshot({ ...answer, state: pending.state });
  };

  // A fresh snapshot replaces whatever output the viewer skipped or would
  // have sent out of order.
  const resync = (): void => {
    actor.send({ type: isIn('stalled') ? 'DRAIN' : 'RESYNC' });

    if (isIn('resyncing')) {
      void requestSnapshot();
    }
  };

  const holdOutput = (seq: number, data: string): void => {
    heldBytes += data.length;

    held.push({ seq, data });

    // A snapshot that takes long to come back holds output no longer than
    // the socket's own allowance; the next snapshot covers what it drops.
    if (heldBytes > options.maxBufferedBytes) {
      held.length = 0;
      heldBytes = 0;
    }
  };

  const applySessionView = (session: SessionDescriptor): void => {
    if (session.id !== sessionID || session.state === pending.state) {
      return;
    }

    pending = { ...pending, state: session.state };

    if (socket !== null) {
      sendControl({ type: 'state', state: session.state });
    }

    if (session.state === 'exited') {
      finish('exited');
    }
  };

  const applyEvent = (event: DaemonEvent): void => {
    match(event)
      .with({ ev: 'SessionOutput' }, (output) => {
        if (output.sessionID !== sessionID) {
          return;
        }

        if (isIn('opening') || isIn('resyncing')) {
          holdOutput(output.seq, output.data);
        } else if (isIn('streaming')) {
          sendOutput(output.seq, output.data);
        }
      })
      .with({ ev: 'SessionDesync' }, (desync) => {
        if (desync.sessionID === sessionID && isIn('streaming')) {
          resync();
        }
      })
      .with({ ev: 'SessionResized' }, (resized) => {
        if (resized.sessionID !== sessionID) {
          return;
        }

        pending = { ...pending, cols: resized.cols, rows: resized.rows };

        if (socket !== null) {
          sendControl({ type: 'resize', cols: resized.cols, rows: resized.rows });
        }
      })
      .with({ ev: 'SessionRemoved' }, (removed) => {
        if (removed.sessionID === sessionID) {
          finish('removed');
        }
      })
      .with(
        { ev: P.union('SessionAdded', 'SessionState', 'SessionAttached', 'SessionDetached') },
        (view) => {
          applySessionView(view.session);
        },
      )
      .with(
        {
          ev: P.union(
            'SessionRenamed',
            'PermissionRequested',
            'PermissionResolved',
            'SessionMessage',
            'SessionNote',
            'InboxMessage',
            'InboxNotice',
            'InboxClosed',
            'DaemonRestarted',
          ),
        },
        () => {},
      )
      .exhaustive();
  };

  channel.onEvent = (event) => {
    if (!isIn('closed')) {
      applyEvent(event);
    }
  };

  channel.onClose = () => {
    finish('daemon_closed');
  };

  return {
    open: (opened) => {
      socket = opened;

      // A session that ended before the browser's socket opened still tells
      // the browser why.
      if (closedReason !== null) {
        sendClosed(closedReason);

        return;
      }

      actor.send({ type: 'OPEN' });

      sendSnapshot(pending);
    },

    drain: () => {
      if (isIn('stalled')) {
        resync();
      }
    },

    close: () => {
      if (isIn('closed')) {
        return;
      }

      actor.send({ type: 'CLOSE' });
      channel.stop();
    },
  };
}
