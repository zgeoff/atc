import type { DaemonConnection, TCPPeer } from './daemon-connection';
import { findTokenFingerprint } from './find-token-fingerprint';
import { HandshakeThrottle } from './handshake-throttle';

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

  // Builds the protocol connection for a newly accepted socket, and
  // releases it once the socket closes.
  readonly openConnection: (socket: ListenerSocket, peer: TCPPeer) => DaemonConnection;

  // oxlint-disable-next-line prefer-readonly-parameter-types -- a connection is a live object the daemon releases
  readonly closeConnection: (connection: DaemonConnection) => void;
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

/**
 * Starts the TCP listener for the client protocol. Every connection must
 * open with a `daemon.hello` that carries a bearer token from the token
 * file, and acts only as the principals its requests give, never as the
 * daemon's owner.
 */
export function startTCPListener(opts: TCPListenerOptions): TCPListener {
  let tokens: readonly string[] | null = opts.tokens;

  const throttle = new HandshakeThrottle(opts.failureDelayMs);
  const connections = new Set<DaemonConnection>();

  const server = Bun.listen<DaemonConnection>({
    hostname: opts.host,
    port: opts.port,
    socket: {
      open(socket) {
        const address = socket.remoteAddress;

        const peer: TCPPeer = {
          verifyHandshake: async (presented) => {
            const delay = throttle.getDelay(address, Date.now());

            if (delay > 0) {
              await Bun.sleep(delay);
            }

            const fingerprint =
              tokens === null || presented === null
                ? null
                : findTokenFingerprint(tokens, presented);

            if (fingerprint === null) {
              throttle.recordFailure(address, Date.now());
            }

            return fingerprint;
          },
          recordFailure: () => {
            throttle.recordFailure(address, Date.now());
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
        connections.delete(socket.data);
        opts.closeConnection(socket.data);
      },
      error() {},
    },
  });

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
    },
  };
}
