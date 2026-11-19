import { setTimeout as sleep } from 'node:timers/promises';
import type { RelayLink, RelayLinkConnection } from '@atc/plugin-api';
import type { ExecConnection, SpritesPort } from '../port/types';
import type { GuestRecords } from './create-guest-records';

interface MuxLinkOptions {
  readonly api: SpritesPort;
  readonly records: GuestRecords;
  readonly sprite: string;
  readonly session: string;

  readonly argv: readonly string[];

  readonly prepare: () => Promise<void>;
  readonly log: (line: string) => void;
}

const STOP_WAIT_MS = 2000;

export function makeMuxLink(options: MuxLinkOptions): RelayLink {
  const api = options.api;

  const stopMux = async (execID: string): Promise<void> => {
    const old = api.openExec(options.sprite, { execID, argv: [], tty: false });
    const ended = Promise.withResolvers<void>();

    old.onEnd(() => {
      ended.resolve();
    });

    try {
      await old.execID;

      old.signal('SIGKILL');

      await Promise.race([ended.promise, sleep(STOP_WAIT_MS)]);
    } catch {
      // a mux that is already gone needs no stop
    } finally {
      old.detach();
    }
  };

  const readEnd = async (execID: string): Promise<'dropped' | 'lost'> => {
    try {
      if ((await api.readSprite(options.sprite)) === null) {
        return 'lost';
      }

      const execs = await api.listExecs(options.sprite);

      return execs.some((exec) => exec.id === execID) ? 'dropped' : 'lost';
    } catch {
      return 'dropped';
    }
  };

  return {
    open: async (openOptions) => {
      const boot = await options.records.readBootID(options.sprite);
      const record = await options.records.readSessionRecord(options.sprite, options.session);
      const execs = await api.listExecs(options.sprite);

      const recorded = record?.mux ?? null;

      const live =
        recorded !== null &&
        recorded.boot === boot &&
        execs.some((exec) => exec.id === recorded.exec)
          ? recorded
          : null;

      const isReplacing = openOptions?.replace === true;

      if (live !== null && isReplacing) {
        await stopMux(live.exec);
      }

      let connection: ExecConnection;

      if (live !== null && !isReplacing) {
        connection = api.openExec(options.sprite, { execID: live.exec, argv: [], tty: false });
      } else {
        await options.prepare();

        connection = api.openExec(options.sprite, {
          argv: options.argv,
          tty: false,
          outlivesClients: true,
        });
      }

      const early: Uint8Array[] = [];
      let dataListener: ((data: Uint8Array) => void) | null = null;
      let endListener: ((end: 'dropped' | 'lost') => void) | null = null;
      let earlyEnd: 'dropped' | 'lost' | null = null;

      connection.onData((data, stream) => {
        if (stream !== 'stdout') {
          return;
        }

        if (dataListener === null) {
          early.push(data);
        } else {
          dataListener(data);
        }
      });

      const emitEnd = (end: 'dropped' | 'lost'): void => {
        if (endListener === null) {
          earlyEnd = end;
        } else {
          endListener(end);
        }
      };

      let startedExec = '';

      const reportDrop = async (): Promise<void> => {
        const end = await readEnd(startedExec);

        emitEnd(end);
      };

      connection.onEnd((end) => {
        if (end.kind === 'exit') {
          emitEnd('lost');

          return;
        }

        void reportDrop();
      });

      const execID = await connection.execID;

      startedExec = execID;

      if (live === null || isReplacing) {
        await options.records.updateSessionRecord(options.sprite, options.session, (current) => ({
          ...current,
          mux: { exec: execID, boot },
        }));

        options.log(`relay mux of session ${options.session} started as exec ${execID}`);
      }

      const opened: RelayLinkConnection = {
        onData: (listener) => {
          dataListener = listener;

          for (const data of early.splice(0)) {
            listener(data);
          }
        },
        onEnd: (listener) => {
          endListener = listener;

          if (earlyEnd !== null) {
            listener(earlyEnd);
          }
        },
        write: (data) => connection.write(data),
        detach: () => {
          connection.detach();
        },
      };

      return opened;
    },
  };
}
