import { createDaemonClient } from '@atc/protocol/client';
import type { DaemonClient } from '@atc/protocol/client';
import { readSessionEnv } from '@atc/protocol/session';
import { HELLO_RESULT_SCHEMA } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';
import type { Clock } from '@zgeoff/std';

const HELLO_FIELDS = HELLO_RESULT_SCHEMA.pick({ daemon: true, daemonID: true });

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
  readonly build: string;

  readonly deadline: number;
  readonly clock: Pick<Clock, 'now' | 'schedule'>;

  readonly keepOpen?: boolean;
}

export async function tryOpenDaemon<T>(
  socketPaths: readonly string[],
  options: DaemonProbeOptions,
  read: (client: Readonly<DaemonClient>) => Promise<T>,
): Promise<DaemonProbe<T> | null> {
  for (const [index, socketPath] of socketPaths.entries()) {
    const client = createDaemonClient(socketPath);
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
        // a refused hello still identifies the daemon, so it ends the probe.
        if (error instanceof AtcError && error.code === 'protocol_mismatch') {
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
