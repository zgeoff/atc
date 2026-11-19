import type { Clock } from '@atc/core';
import { formatLogField } from '../logging/format-log-field';
import type { DaemonConnection } from './create-daemon-connection';
import { createHandshakeThrottle } from './create-handshake-throttle';
import { createRefusalLog } from './create-refusal-log';
import { findTokenFingerprint } from './find-token-fingerprint';
import type { TCPPeer } from './tcp-peer';

interface ListenerSocket {
  readonly write: (data: Uint8Array) => number;
  readonly end: () => void;
}

interface TCPListenerOptions {
  readonly host: string;
  readonly port: number;
  readonly tokens: readonly string[];

  readonly failureDelayMs: number;

  readonly maxDelayedHandshakes: number;

  readonly openConnection: (socket: ListenerSocket, peer: TCPPeer) => DaemonConnection;

  readonly closeConnection: (connection: DaemonConnection) => void;

  readonly log: (line: string) => void;
  readonly refusalLogIntervalMs: number;

  readonly clock: Clock;

  readonly maxRefusalWindows: number;
}

export interface TCPListener {
  readonly port: number;

  readonly setTokens: (tokens: readonly string[] | null) => void;
  readonly stop: () => void;
}

export function startTCPListener(opts: TCPListenerOptions): TCPListener {
  let tokens: readonly string[] | null = opts.tokens;
  const throttle = createHandshakeThrottle(opts.failureDelayMs);

  const connections = new Set<DaemonConnection>();

  const refusals = createRefusalLog({
    log: opts.log,
    now: opts.clock.now,
    intervalMs: opts.refusalLogIntervalMs,
    maxWindows: opts.maxRefusalWindows,
  });

  let delayed = 0;

  const closedSockets = new WeakMap<object, (value: 'closed') => void>();

  const server = Bun.listen<DaemonConnection>({
    hostname: opts.host,
    port: opts.port,
    socket: {
      open(socket) {
        const address = socket.remoteAddress;
        const closed = Promise.withResolvers<'closed'>();

        closedSockets.set(socket, closed.resolve);

        const peer: TCPPeer = {
          verifyHandshake: async (presented) => {
            const delay = throttle.getDelay(address, opts.clock.now());

            if (delay > 0 && delayed >= opts.maxDelayedHandshakes) {
              throttle.recordFailure(address, opts.clock.now());

              refusals.record({
                event: 'handshake_refused',
                peer: address,
                reason: 'delay_cap_full',
              });

              return null;
            }

            if (delay > 0) {
              delayed++;

              const elapsed = Promise.withResolvers<'elapsed'>();

              const cancel = opts.clock.schedule(() => {
                elapsed.resolve('elapsed');
              }, delay);

              const waited = await Promise.race([elapsed.promise, closed.promise]);

              cancel();

              delayed--;

              if (waited === 'closed') {
                refusals.record({
                  event: 'handshake_refused',
                  peer: address,
                  reason: 'closed_during_delay',
                });

                return null;
              }
            }

            const fingerprint =
              tokens === null || presented === null
                ? null
                : findTokenFingerprint(tokens, presented);

            if (fingerprint === null) {
              throttle.recordFailure(address, opts.clock.now());

              refusals.record({
                event: 'handshake_refused',
                peer: address,
                reason: presented === null ? 'missing_token' : 'unauthorized',
              });
            }

            return fingerprint;
          },
          recordFailure: (reason) => {
            throttle.recordFailure(address, opts.clock.now());
            refusals.record({ event: 'handshake_refused', peer: address, reason });
          },
          recordRefusedPrincipal: () => {
            refusals.record({ event: 'principal_refused', peer: address });
          },
        };

        socket.data = opts.openConnection(socket, peer);

        connections.add(socket.data);
      },
      data(socket, buf) {
        socket.data.applyChunk(socket.data.decodeChunk(buf));
      },
      drain(socket) {
        socket.data.drain();
      },
      close(socket) {
        closedSockets.get(socket)?.('closed');
        closedSockets.delete(socket);
        connections.delete(socket.data);
        opts.closeConnection(socket.data);
      },
      error() {},
    },
  });

  opts.log(
    `atc tcp event=listening host=${formatLogField(server.hostname)} port=${String(server.port)}`,
  );

  return {
    port: server.port,
    setTokens(next) {
      tokens = next;

      const kept =
        next === null
          ? new Set<string>()
          : new Set(next.map((token) => findTokenFingerprint([token], token)));

      for (const connection of connections) {
        const fingerprint = connection.tokenFingerprint;

        if (fingerprint !== null && !kept.has(fingerprint)) {
          connection.dispose();
        }
      }
    },
    stop() {
      for (const connection of connections) {
        connection.dispose();
      }

      server.stop(true);
      refusals.drain();
    },
  };
}
