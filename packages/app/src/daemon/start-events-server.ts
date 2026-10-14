import { unlinkSync } from 'node:fs';
import { OutboundQueue } from '@atc/protocol/outbound-queue';
import { encodeMessage } from '@atc/protocol/protocol';
import type { EventMsg } from '@atc/protocol/protocol';

interface EventsServerOptions {
  readonly socketPath: string;

  // Events replayed to a subscriber the moment it connects, ahead of any
  // live broadcast, so a subscriber learns the current fleet without
  // speaking the client protocol.
  readonly collectSnapshot: () => readonly EventMsg[];

  // Whether to close a connection the moment it opens, before it reads
  // anything, given the accepted socket.
  readonly shouldRefusePeer?: (socket: object) => boolean;

  // Outbound queue capacity per subscriber; small values force the overflow
  // disconnect in tests.
  readonly queueBytes?: number;
}

interface EventsServer {
  readonly broadcast: (event: EventMsg) => void;
  readonly stop: () => void;
}

interface Subscriber {
  readonly queue: OutboundQueue;
  readonly end: () => void;
}

/**
 * Starts the read-only events listener. A subscriber connects with no
 * handshake and receives NDJSON wire events: first the snapshot, then every
 * broadcast behind it. Input on the socket is ignored. A subscriber whose
 * outbound queue overflows is disconnected rather than stalled — on
 * reconnect it gets a fresh snapshot instead of the backlog it missed. A
 * peer the options refuse is closed before it gets the snapshot.
 */
export function startEventsServer(opts: EventsServerOptions): EventsServer {
  const subscribers = new Set<Subscriber>();

  try {
    unlinkSync(opts.socketPath);
  } catch {}

  const server = Bun.listen<Subscriber>({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        const subscriber: Subscriber = {
          queue: new OutboundQueue(socket, opts.queueBytes),
          end: () => {
            socket.end();
          },
        };

        socket.data = subscriber;

        if (opts.shouldRefusePeer?.(socket) === true) {
          subscriber.end();

          return;
        }

        subscribers.add(subscriber);

        for (const event of opts.collectSnapshot()) {
          if (!subscriber.queue.send(encodeMessage(event))) {
            subscriber.end();

            return;
          }
        }
      },
      data() {},
      drain(socket) {
        socket.data.queue.drain();
      },
      close(socket) {
        subscribers.delete(socket.data);
      },
      error() {},
    },
  });

  return {
    broadcast(event) {
      const line = encodeMessage(event);

      for (const subscriber of subscribers) {
        if (!subscriber.queue.send(line)) {
          subscriber.end();
        }
      }
    },
    stop() {
      server.stop(true);

      for (const subscriber of subscribers) {
        subscriber.end();
      }

      subscribers.clear();
    },
  };
}
