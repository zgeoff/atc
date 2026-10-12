import type { Clock } from '@atc/core/system-clock';
import { DaemonClient } from '@atc/protocol/client/daemon-client';
import { DaemonError } from '@atc/protocol/daemon-error';
import { HELLO_RESULT_SCHEMA } from '@atc/protocol/hello-result';
import { readSessionEnv } from '@atc/protocol/read-session-env';

// The fields of the handshake answer a probe reads; a daemon from before
// either field answers without it.
const HELLO_FIELDS = HELLO_RESULT_SCHEMA.pick({ daemon: true, daemonID: true }).partial();

// The daemon's answer to the handshake: its build, `unknown` when the answer
// holds none, and its stable id, null when it holds none.
interface DaemonHello {
  readonly build: string;
  readonly daemonID: string | null;
}

export type DaemonProbe<T> =
  | {
      readonly kind: 'ok';
      readonly socketPath: string;
      readonly hello: DaemonHello;
      readonly value: T;
    }
  | { readonly kind: 'refused'; readonly socketPath: string; readonly message: string };

interface DaemonProbeOptions {
  // The build this client sends in its hello.
  readonly build: string;

  // The clock time by which the hello and `read` must finish.
  readonly deadline: number;
  readonly clock: Clock;

  // Leaves the client open once `read` resolves, for a caller that goes on
  // to use it and closes it itself.
  readonly keepOpen?: boolean;
}

/**
 * Opens the daemon at the first of `socketPaths` that answers, sends this
 * build's hello, and runs `read` on the open client. The hello and `read`
 * together must finish within the socket's share of the time left before
 * the deadline: a daemon that accepts the socket and never answers has its
 * client closed then, which rejects every request still waiting. A hello the daemon's protocol refuses ends the probe with
 * the refusal, since it still identifies the daemon; a socket that refuses
 * the connection, or a daemon that closes it before it answers, passes the
 * probe to the next socket. Resolves null when no socket answers. The
 * client closes once `read` settles, unless `keepOpen` is set, and a `read`
 * that rejects rejects the probe.
 */
export async function tryOpenDaemon<T>(
  socketPaths: readonly string[],
  options: DaemonProbeOptions,
  read: (client: Readonly<DaemonClient>) => Promise<T>,
): Promise<DaemonProbe<T> | null> {
  for (const [index, socketPath] of socketPaths.entries()) {
    let client: DaemonClient;

    try {
      client = await DaemonClient.open(socketPath);
    } catch {
      continue;
    }

    // Each socket gets an equal share of the time left, so one that never
    // answers leaves the sockets after it time to answer.
    const remainingMs = Math.max(0, options.deadline - options.clock.now());

    const cancelExpiry = options.clock.schedule(
      () => {
        client.stop();
      },
      remainingMs / (socketPaths.length - index),
    );

    let keep = false;

    try {
      let answer: Readonly<Record<string, unknown>>;

      try {
        answer = await client.sendHello(options.build, {
          session: readSessionEnv(process.env).sessionID,
        });
      } catch (error) {
        if (error instanceof DaemonError && error.code === 'protocol_mismatch') {
          return { kind: 'refused', socketPath, message: error.message };
        }

        continue;
      }

      const value = await read(client);

      keep = options.keepOpen === true;

      const fields = HELLO_FIELDS.safeParse(answer);

      return {
        kind: 'ok',
        socketPath,
        hello: {
          build: (fields.success ? fields.data.daemon : undefined) ?? 'unknown',
          daemonID: (fields.success ? fields.data.daemonID : undefined) ?? null,
        },
        value,
      };
    } finally {
      cancelExpiry();

      if (!keep) {
        client.stop();
      }
    }
  }

  return null;
}
