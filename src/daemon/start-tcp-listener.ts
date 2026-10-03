import type { DaemonConnection, TCPPeer } from './daemon-connection';
import { findTokenFingerprint } from './find-token-fingerprint';
import { formatLogField } from './format-log-field';
import { HandshakeThrottle } from './handshake-throttle';
import { RefusalLog } from './refusal-log';

// The slice of an accepted socket a protocol connection writes to and ends.
interface ListenerSocket {
  // oxlint-disable-next-line prefer-readonly-parameter-types -- a socket write takes a buffer with no readonly form
  readonly write: (data: Uint8Array) => number;
  readonly end: () => void;
}

interface TCPListenerOptions {
  readonly host: string;
  readonly port: number;
  readonly tokens: readonly string[];

  // How long a handshake waits once its address has failed too often.
  readonly failureDelayMs: number;

  // How many delayed handshakes may wait at once across every address.
  readonly maxDelayedHandshakes: number;

  // Builds the protocol connection for a newly accepted socket, and
  // releases it once the socket closes.
  readonly openConnection: (socket: ListenerSocket, peer: TCPPeer) => DaemonConnection;

  // oxlint-disable-next-line prefer-readonly-parameter-types -- a connection is a live object the daemon releases
  readonly closeConnection: (connection: DaemonConnection) => void;

  // Where the listener start and each refusal are logged, one line at a
  // time, with the clock and the window that summarize repeated refusals
  // from one peer.
  readonly log: (line: string) => void;
  readonly now: () => number;
  readonly refusalLogIntervalMs: number;
}

export interface TCPListener {
  // The port the listener bound, which a requested port of 0 leaves to the
  // kernel.
  readonly port: number;

  // Replaces the tokens a handshake may present, closing at once every
  // connection whose handshake token is not among them. Null drops every
  // token: every connection closes and every handshake is refused.
  readonly setTokens: (tokens: readonly string[] | null) => void;
  readonly stop: () => void;
}

// How many peers and kinds of refusal the refusal log tracks at once.
const MAX_REFUSAL_WINDOWS = 1024;

/**
 * Starts the TCP listener for the client protocol. Every connection must
 * open with a `daemon.hello` that carries a bearer token from the token
 * file, and acts only as the principals its requests give, never as the
 * daemon's owner. A delayed handshake ends early, refused, once its socket
 * closes, and a handshake that would wait while the cap of delayed
 * handshakes is full is refused at once and counted as a failure, so a
 * flood across many sockets holds at most the cap of waits.
 */
export function startTCPListener(opts: TCPListenerOptions): TCPListener {
  let tokens: readonly string[] | null = opts.tokens;

  const throttle = new HandshakeThrottle(opts.failureDelayMs);
  const connections = new Set<DaemonConnection>();

  const refusals = new RefusalLog({
    log: opts.log,
    now: opts.now,
    intervalMs: opts.refusalLogIntervalMs,
    maxWindows: MAX_REFUSAL_WINDOWS,
  });

  let delayed = 0;

  // Ends the delayed handshake of each open socket once it closes.
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
            const delay = throttle.getDelay(address, Date.now());

            if (delay > 0 && delayed >= opts.maxDelayedHandshakes) {
              throttle.recordFailure(address, Date.now());

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

              const timer = setTimeout(() => {
                elapsed.resolve('elapsed');
              }, delay);

              const waited = await Promise.race([elapsed.promise, closed.promise]);

              clearTimeout(timer);

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
              throttle.recordFailure(address, Date.now());

              refusals.record({
                event: 'handshake_refused',
                peer: address,
                reason: presented === null ? 'missing_token' : 'unauthorized',
              });
            }

            return fingerprint;
          },
          recordFailure: (reason) => {
            throttle.recordFailure(address, Date.now());
            refusals.record({ event: 'handshake_refused', peer: address, reason });
          },
          recordRefusedPrincipal: (principal) => {
            refusals.record({ event: 'principal_refused', peer: address, principal });
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
