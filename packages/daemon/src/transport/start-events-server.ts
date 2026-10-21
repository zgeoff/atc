import { unlinkSync } from 'node:fs';
import { createOutboundQueue, encodeMessage } from '@atc/protocol/wire';
import type { EventMsg, OutboundQueue } from '@atc/protocol/wire';
import { withOwnerOnlySocket } from './with-owner-only-socket';

interface EventsServerOptions {
  readonly socketPath: string;

  // Events replayed to a subscriber the moment it connects, ahead of any
  // live broadcast, so a subscriber learns the current fleet without
  // speaking the client protocol.
  readonly collectSnapshot: () => readonly EventMsg[];

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

export function startEventsServer(opts: EventsServerOptions): EventsServer {
  const subscribers = new Set<Subscriber>();

  try {
    unlinkSync(opts.socketPath);
  } catch {}

  const server = withOwnerOnlySocket(opts.socketPath, () =>
    Bun.listen<Subscriber>({
      unix: opts.socketPath,
      socket: {
        open(socket) {
          const subscriber: Subscriber = {
            queue: createOutboundQueue(socket, opts.queueBytes),
            end: () => {
              socket.end();
            },
          };

          socket.data = subscriber;

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
    }),
  );

  return {
    broadcast(event) {
      const line = encodeMessage(event);

      for (const subscriber of subscribers) {
        if (!subscriber.queue.send(line)) {
          // a subscriber that falls behind is dropped rather than stalled; on reconnect it gets
          // a fresh snapshot instead of the backlog it missed
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
