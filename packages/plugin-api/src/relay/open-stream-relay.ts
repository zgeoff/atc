/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys */
import { randomUUID } from 'node:crypto';
import { systemClock } from '@atc/core';
import { createByteLineSplitter, formatRelayFrame, parseGuestFrame } from '@atc/protocol/relay';
import type { DaemonFrame, GuestFrame } from '@atc/protocol/relay';
import type { HarnessRelay } from '../execution/execution-provider';
import type { OpenedRelay, RelayLink, RelayLinkConnection, StreamRelayOptions } from './relay-link';

// The most frame bytes the daemon holds unacked per relay.
const MAX_UNACKED_BYTES = 1024 * 1024;

// A connection counts as dropped when no welcome follows its hello this soon.
const WELCOME_TIMEOUT_MS = 10_000;

const encoder = new TextEncoder();

type Phase = 'connecting' | 'awaiting-welcome' | 'ready' | 'waiting-retry' | 'stopped';

// A frame the daemon sent or will send, held until the guest acks it.
interface HeldFrame {
  readonly seq: number;
  readonly frame: Extract<DaemonFrame, { seq: number }>;
  readonly bytes: number;
}

// A line, or the close of its connection when `line` is null, waiting for room in the window.
interface PendingWrite {
  readonly conn: number;
  readonly line: string | null;
  readonly settle: { readonly resolve: () => void; readonly reject: (error: Error) => void };
}

interface BridgeConnection {
  readonly id: number;
  readonly lineListeners: ((line: string) => void)[];
  readonly closeListeners: (() => void)[];
  readonly endListeners: (() => void)[];
  closed: boolean;
}

// One attempt at the link: its connection, and the welcome it waits for.
interface Attempt {
  readonly gen: number;
  readonly connection: RelayLinkConnection;
  cancelTimeout: () => void;
}

// Carries the session bridge over the link's byte stream: every frame reaches the other side once
// and in order across dropped connections, until the host loses the mux or stop() runs.
export function openStreamRelay(
  link: RelayLink,
  onRelay: (relay: HarnessRelay) => void,
  options: StreamRelayOptions,
): OpenedRelay {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? (() => {});
  const relayID = randomUUID();
  const listening = Promise.withResolvers<void>();

  // an unawaited rejection never crashes the daemon
  void ignoreRejection(listening.promise);
  let phase: Phase = 'connecting';
  let heardWelcome = false;
  let gen = 0;
  let attempt: Attempt | null = null;
  let replaceNext = false;
  let failures = 0;
  let cancelRetry: (() => void) | null = null;

  // numbering and replay state
  let nextSeq = 1;
  let appliedGuestSeq = 0;
  let held: HeldFrame[] = [];
  let heldBytes = 0;
  let pending: PendingWrite[] = [];

  const bridges = new Map<number, BridgeConnection>();

  const isStopped = (): boolean => phase === 'stopped';

  const closeBridges = (): void => {
    for (const bridge of bridges.values()) {
      bridges.delete(bridge.id);

      bridge.closed = true;

      for (const listener of bridge.closeListeners) {
        listener();
      }
    }

    const dropped = pending;

    pending = [];

    for (const write of dropped) {
      write.settle.reject(new Error('the relay closed before the line fit'));
    }
  };

  const sendFrames = (target: Attempt, frames: readonly (DaemonFrame | string)[]): void => {
    const bytes = encoder.encode(
      frames.map((frame) => (typeof frame === 'string' ? frame : formatRelayFrame(frame))).join(''),
    );

    void writeBytes(target, bytes);
  };

  const writeBytes = async (target: Attempt, bytes: Uint8Array): Promise<void> => {
    try {
      await target.connection.write(bytes);
    } catch (error) {
      log(`relay write failed (${error instanceof Error ? error.message : String(error)})`);
      drop(target);
    }
  };

  const hold = (frame: HeldFrame['frame']): void => {
    const bytes = encoder.encode(formatRelayFrame(frame)).length;

    held.push({ seq: frame.seq, frame, bytes });

    heldBytes += bytes;

    if (phase === 'ready' && attempt !== null) {
      sendFrames(attempt, [frame]);
    }
  };

  // admits each pending write, in order, once its frame fits under the cap
  const admitPending = (): void => {
    while (pending.length > 0) {
      const [next] = pending;

      if (next === undefined) {
        return;
      }

      const frame: HeldFrame['frame'] =
        next.line === null
          ? { t: 'close', seq: nextSeq, conn: next.conn }
          : { t: 'line', seq: nextSeq, conn: next.conn, line: next.line };

      const bytes = encoder.encode(formatRelayFrame(frame)).length;

      // the final sequence number may be longer than the one at queue time, so a frame that
      // can never fit is rejected here, where its size is known
      if (bytes > MAX_UNACKED_BYTES) {
        pending.shift();
        next.settle.reject(new Error('the line is larger than the relay window'));
        continue;
      }

      if (heldBytes + bytes > MAX_UNACKED_BYTES) {
        return;
      }

      pending.shift();

      nextSeq += 1;

      hold(frame);

      next.settle.resolve();
    }
  };

  const releaseAcked = (ack: number): void => {
    const kept = held.filter((entry) => entry.seq > ack);

    if (kept.length === held.length) {
      return;
    }

    held = kept;
    heldBytes = kept.reduce((total, entry) => total + entry.bytes, 0);

    admitPending();
  };

  const toHarnessRelay = (bridge: BridgeConnection): HarnessRelay => ({
    onLine: (listener) => {
      bridge.lineListeners.push(listener);
    },
    onClose: (listener) => {
      bridge.closeListeners.push(listener);
    },
    onEnd: (listener) => {
      bridge.endListeners.push(listener);
    },
    writeLine: (line) => {
      if (bridge.closed) {
        return Promise.reject(new Error('the bridge connection is closed'));
      }

      const bytes = encoder.encode(
        formatRelayFrame({ t: 'line', seq: nextSeq, conn: bridge.id, line }),
      ).length;

      if (bytes > MAX_UNACKED_BYTES) {
        return Promise.reject(new Error('the line is larger than the relay window'));
      }

      const written = Promise.withResolvers<void>();

      pending.push({ conn: bridge.id, line, settle: written });

      admitPending();

      return written.promise;
    },
    close: () => {
      if (bridge.closed) {
        return;
      }

      bridge.closed = true;

      pending.push({
        conn: bridge.id,
        line: null,
        settle: { resolve: () => {}, reject: () => {} },
      });

      admitPending();
    },
  });

  const applyGuestFrame = (frame: Exclude<GuestFrame, { t: 'welcome' | 'ack' }>): void => {
    if (frame.t === 'open') {
      const bridge: BridgeConnection = {
        id: frame.conn,
        lineListeners: [],
        closeListeners: [],
        endListeners: [],
        closed: false,
      };

      bridges.set(bridge.id, bridge);

      onRelay(toHarnessRelay(bridge));

      return;
    }

    const bridge = bridges.get(frame.conn);

    if (bridge === undefined) {
      return;
    }

    if (frame.t === 'line') {
      for (const listener of bridge.lineListeners) {
        listener(frame.line);
      }
    } else if (frame.t === 'end') {
      for (const listener of bridge.endListeners) {
        listener();
      }
    } else {
      bridges.delete(bridge.id);

      bridge.closed = true;

      for (const listener of bridge.closeListeners) {
        listener();
      }
    }
  };

  const resetNumbering = (): void => {
    closeBridges();

    nextSeq = 1;
    appliedGuestSeq = 0;
    held = [];
    heldBytes = 0;
  };

  const retryLater = (): void => {
    phase = 'waiting-retry';

    const delays = options.reconnectDelaysMs;
    const delayMs = delays[Math.min(failures, delays.length - 1)] ?? 0;

    failures += 1;

    log(`relay connection lost; opening it again in ${delayMs}ms`);

    cancelRetry = clock.schedule(() => {
      cancelRetry = null;
      void connect();
    }, delayMs);
  };

  const finishStopped = (reason: string): void => {
    phase = 'stopped';
    cancelRetry?.();
    cancelRetry = null;
    attempt?.cancelTimeout();
    const last = attempt;

    attempt = null;
    last?.connection.detach();
    closeBridges();

    listening.reject(new Error(reason));
  };

  const drop = (target: Attempt): void => {
    if (attempt !== target || isStopped()) {
      return;
    }

    target.cancelTimeout();
    target.connection.detach();

    attempt = null;

    retryLater();
  };

  const handleWelcome = (target: Attempt, frame: Extract<GuestFrame, { t: 'welcome' }>): void => {
    target.cancelTimeout();

    phase = 'ready';
    failures = 0;
    replaceNext = false;

    if (frame.reset) {
      resetNumbering();
    } else {
      releaseAcked(frame.ack);
    }

    if (!heardWelcome) {
      heardWelcome = true;

      listening.resolve();
    }

    if (held.length > 0) {
      sendFrames(
        target,
        held.map((entry) => entry.frame),
      );
    }

    admitPending();
  };

  const handleGuestFrames = (target: Attempt, lines: readonly string[]): void => {
    let sawNumbered = false;

    for (const line of lines) {
      if (attempt !== target || isStopped()) {
        return;
      }

      const frame = parseGuestFrame(line);

      if (frame === null) {
        continue;
      }

      if (phase === 'awaiting-welcome') {
        if (frame.t !== 'welcome' || frame.relay !== relayID || frame.gen !== target.gen) {
          continue;
        }

        if (frame.v !== 1) {
          replaceOldMux(target);

          return;
        }

        if ('reset' in frame) {
          handleWelcome(target, frame);
        }

        continue;
      }

      if (frame.t === 'welcome') {
        continue;
      }

      if (frame.t === 'ack') {
        releaseAcked(frame.ack);
        continue;
      }

      sawNumbered = true;

      if (frame.seq === appliedGuestSeq + 1) {
        appliedGuestSeq = frame.seq;

        applyGuestFrame(frame);
      }
    }

    if (sawNumbered && attempt === target && phase === 'ready') {
      sendFrames(target, [{ t: 'ack', ack: appliedGuestSeq }]);
    }
  };

  // a mux that speaks another version is stopped, and a new one answers the next hello
  const replaceOldMux = (target: Attempt): void => {
    target.cancelTimeout();
    target.connection.detach();

    attempt = null;

    if (replaceNext) {
      retryLater();

      return;
    }

    log('relay mux speaks another version; replacing it');

    replaceNext = true;
    void connect();
  };

  const connect = async (): Promise<void> => {
    if (isStopped()) {
      return;
    }

    phase = 'connecting';
    gen += 1;

    const thisGen = gen;
    let connection: RelayLinkConnection;

    try {
      const openOptions = replaceNext ? { replace: true } : undefined;

      connection = await link.open(openOptions);
    } catch (error) {
      if (!isStopped() && thisGen === gen) {
        log(`relay link did not open (${error instanceof Error ? error.message : String(error)})`);
        retryLater();
      }

      return;
    }

    if (isStopped() || thisGen !== gen) {
      connection.detach();

      return;
    }

    const target: Attempt = { gen: thisGen, connection, cancelTimeout: () => {} };
    const splitLines = createByteLineSplitter();

    attempt = target;
    phase = 'awaiting-welcome';

    connection.onData((data) => {
      if (attempt === target) {
        handleGuestFrames(target, splitLines(data));
      }
    });

    connection.onEnd((end) => {
      if (attempt !== target) {
        return;
      }

      if (end === 'lost') {
        log('relay host no longer runs the mux; the relay stops');
        finishStopped('the host lost the relay mux');

        return;
      }

      drop(target);
    });

    target.cancelTimeout = clock.schedule(() => {
      log('relay got no welcome in time');
      drop(target);
    }, WELCOME_TIMEOUT_MS);

    // the newline ends any half line a cut-off write left in the guest's stdin
    sendFrames(target, [
      '\n',
      { t: 'hello', v: 1, relay: relayID, gen: thisGen, ack: appliedGuestSeq },
    ]);
  };

  void connect();

  return {
    listening: listening.promise,
    stop: () => {
      if (!isStopped()) {
        finishStopped('the relay stopped');
      }
    },
  };
}

// Waits out a promise whose rejection the caller reads elsewhere.
async function ignoreRejection(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // the caller of the promise sees the rejection
  }
}
