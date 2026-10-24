import type { Clock } from '@atc/core';
import { openDaemonClient } from '@atc/protocol/client';
import type { DaemonClient } from '@atc/protocol/client';
import { readSessionEnv } from '@atc/protocol/session';
import { DaemonError } from '@atc/protocol/wire';
import { HELLO_RESULT_SCHEMA } from '@atcx/contract';

const HELLO_FIELDS = HELLO_RESULT_SCHEMA.pick({ daemon: true, daemonID: true });

// The daemon's answer to the handshake: its build and its stable id.
interface DaemonHello {
  readonly build: string;
  readonly daemonID: string;
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

export async function tryOpenDaemon<T>(
  socketPaths: readonly string[],
  options: DaemonProbeOptions,
  read: (client: Readonly<DaemonClient>) => Promise<T>,
): Promise<DaemonProbe<T> | null> {
  for (const [index, socketPath] of socketPaths.entries()) {
    let client: DaemonClient;

    try {
      client = await openDaemonClient(socketPath);
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
        // a refused hello still identifies the daemon, so it ends the probe; any
        // other failure passes the probe to the next socket.
        if (error instanceof DaemonError && error.code === 'protocol_mismatch') {
          return { kind: 'refused', socketPath, message: error.message };
        }

        continue;
      }

      const fields = HELLO_FIELDS.safeParse(answer);

      if (!fields.success) {
        return {
          kind: 'refused',
          socketPath,
          message: 'the daemon answered the handshake without its build and id',
        };
      }

      const value = await read(client);

      keep = options.keepOpen === true;

      return {
        kind: 'ok',
        socketPath,
        hello: { build: fields.data.daemon, daemonID: fields.data.daemonID },
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
