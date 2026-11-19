/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys */
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { createByteLineSplitter, formatRelayFrame, parseDaemonFrame } from '@atc/protocol/relay';
import type { DaemonFrame, GuestFrame } from '@atc/protocol/relay';

const MAX_UNACKED_BYTES = 1024 * 1024;

type NumberedFrame = Extract<GuestFrame, { seq: number }>;

interface HeldFrame {
  readonly frame: NumberedFrame;
  readonly bytes: number;
}

interface Bridge {
  readonly id: number;
  readonly socket: Socket;
  readonly splitLines: (chunk: Uint8Array) => string[];

  closeSeq: number | null;

  retired: boolean;
}

export interface RelayMux {
  readonly feed: (bytes: Uint8Array) => void;
  readonly stop: () => Promise<void>;
}

interface RelayMuxOptions {
  readonly socketPath: string;

  readonly writeStdout: (text: string) => void;
}

export async function startRelayMux(options: RelayMuxOptions): Promise<RelayMux> {
  const bridges = new Map<number, Bridge>();

  const waiting: Socket[] = [];
  const splitDaemonLines = createByteLineSplitter();

  const encoder = new TextEncoder();

  let relayID: string | null = null;
  let welcomed = false;
  let nextBridge = 1;
  let nextSeq = 1;
  let appliedDaemonSeq = 0;
  let held: HeldFrame[] = [];
  let heldBytes = 0;

  const writeFrames = (frames: readonly GuestFrame[]): void => {
    options.writeStdout(frames.map((frame) => formatRelayFrame(frame)).join(''));
  };

  const hasRoom = (): boolean => heldBytes < MAX_UNACKED_BYTES;

  const emit = (build: (seq: number) => NumberedFrame): number => {
    const frame = build(nextSeq);

    nextSeq += 1;

    held.push({ frame, bytes: encoder.encode(formatRelayFrame(frame)).length });

    heldBytes += held.at(-1)?.bytes ?? 0;

    if (welcomed) {
      writeFrames([frame]);
    }

    return frame.seq;
  };

  const attach = (socket: Socket): void => {
    const bridge: Bridge = {
      id: nextBridge,
      socket,
      splitLines: createByteLineSplitter(),
      closeSeq: null,
      retired: false,
    };

    nextBridge += 1;

    bridges.set(bridge.id, bridge);

    emit((seq) => ({ t: 'open', seq, conn: bridge.id }));

    socket.on('data', (data) => {
      if (bridge.retired) {
        return;
      }

      const bytes = typeof data === 'string' ? encoder.encode(data) : data;

      for (const line of bridge.splitLines(bytes)) {
        emit((seq) => ({ t: 'line', seq, conn: bridge.id, line }));
      }

      if (!hasRoom()) {
        socket.pause();
      }
    });

    socket.on('end', () => {
      if (bridge.retired) {
        return;
      }

      emit((seq) => ({ t: 'end', seq, conn: bridge.id }));
    });

    socket.on('error', () => {});

    socket.on('close', () => {
      if (bridge.retired) {
        return;
      }

      bridge.closeSeq = emit((seq) => ({ t: 'close', seq, conn: bridge.id }));
    });

    socket.resume();
  };

  const admitWaiting = (): void => {
    while (waiting.length > 0 && hasRoom()) {
      const socket = waiting.shift();

      if (socket !== undefined && !socket.destroyed) {
        attach(socket);
      }
    }

    if (hasRoom()) {
      for (const bridge of bridges.values()) {
        bridge.socket.resume();
      }
    }
  };

  const releaseAcked = (ack: number): void => {
    held = held.filter((entry) => entry.frame.seq > ack);
    heldBytes = held.reduce((total, entry) => total + entry.bytes, 0);

    for (const bridge of bridges.values()) {
      if (bridge.closeSeq !== null && bridge.closeSeq <= ack) {
        bridges.delete(bridge.id);
      }
    }

    admitWaiting();
  };

  const resetBridges = (): void => {
    for (const bridge of bridges.values()) {
      bridge.retired = true;

      bridge.socket.destroy();
    }

    bridges.clear();

    held = [];
    heldBytes = 0;
    nextSeq = 1;
    appliedDaemonSeq = 0;
  };

  const handleHello = (hello: Extract<DaemonFrame, { t: 'hello' }>): void => {
    const reset = hello.relay !== relayID;

    if (reset) {
      if (relayID !== null) {
        resetBridges();
      }

      relayID = hello.relay;
    } else {
      releaseAcked(hello.ack);
    }

    welcomed = true;

    writeFrames([
      {
        t: 'welcome',
        v: 1,
        relay: hello.relay,
        gen: hello.gen,
        ack: appliedDaemonSeq,
        reset,
      },
      ...held.map((entry) => entry.frame),
    ]);
  };

  const applyDaemonFrame = (frame: Extract<DaemonFrame, { seq: number }>): void => {
    const bridge = bridges.get(frame.conn);

    if (frame.t === 'line') {
      bridge?.socket.write(`${frame.line}\n`);
    } else {
      bridge?.socket.end();
    }
  };

  const handleDaemonLine = (line: string): boolean => {
    const frame = parseDaemonFrame(line);

    if (frame === null) {
      return false;
    }

    if (frame.t === 'hello') {
      handleHello(frame);

      return false;
    }

    if (frame.t === 'ack') {
      releaseAcked(frame.ack);

      return false;
    }

    if (frame.seq !== appliedDaemonSeq + 1) {
      return frame.seq <= appliedDaemonSeq;
    }

    appliedDaemonSeq = frame.seq;

    applyDaemonFrame(frame);

    return true;
  };

  rmSync(options.socketPath, { force: true });

  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    if (hasRoom() && waiting.length === 0) {
      attach(socket);

      return;
    }

    socket.pause();
    socket.on('error', () => {});
    waiting.push(socket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);

    server.listen(options.socketPath, () => {
      server.off('error', reject);

      resolve();
    });
  });

  return {
    feed: (bytes) => {
      let sawNumbered = false;

      for (const line of splitDaemonLines(bytes)) {
        sawNumbered = handleDaemonLine(line) || sawNumbered;
      }

      if (sawNumbered && relayID !== null) {
        writeFrames([{ t: 'ack', ack: appliedDaemonSeq }]);
      }
    },
    stop: async () => {
      resetBridges();

      for (const socket of waiting) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
