/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys */
import { createByteLineSplitter, formatRelayFrame, parseDaemonFrame } from '@atc/protocol/relay';
import type { DaemonFrame, GuestFrame } from '@atc/protocol/relay';
import type { RelayLink, RelayLinkConnection } from '../relay/relay-link';

interface HelloAnswer {
  readonly ack: number;
  readonly reset: boolean;
}

interface StubConnection {
  readonly onData: ((data: Uint8Array) => void)[];
  readonly onEnd: ((end: 'dropped' | 'lost') => void)[];
  detached: boolean;
}

export function buildStubRelayLink() {
  const encoder = new TextEncoder();

  const splitLines = createByteLineSplitter();
  const connections: StubConnection[] = [];
  const stdout: Uint8Array[] = [];
  const daemonFrames: DaemonFrame[] = [];
  const replaceFlags: boolean[] = [];
  let failOpens = 0;
  const current = (): StubConnection | undefined => connections.at(-1);

  const link: RelayLink = {
    open: (options) => {
      replaceFlags.push(options?.replace === true);

      if (failOpens > 0) {
        failOpens -= 1;

        return Promise.reject(new Error('the host refused the exec'));
      }

      const stub: StubConnection = { onData: [], onEnd: [], detached: false };

      connections.push(stub);

      const connection: RelayLinkConnection = {
        onData: (listener) => {
          stub.onData.push(listener);

          for (const chunk of stdout) {
            listener(chunk);
          }
        },
        onEnd: (listener) => {
          stub.onEnd.push(listener);
        },
        write: (data) => {
          if (stub.detached) {
            return Promise.reject(new Error('the connection is detached'));
          }

          for (const line of splitLines(data)) {
            const frame = parseDaemonFrame(line);

            if (frame !== null) {
              daemonFrames.push(frame);
            }
          }

          return Promise.resolve();
        },
        detach: () => {
          stub.detached = true;
        },
      };

      return Promise.resolve(connection);
    },
  };

  const writeStdout = (text: string): void => {
    const bytes = encoder.encode(text);

    stdout.push(bytes);

    const open = current();

    if (open !== undefined && !open.detached) {
      for (const listener of open.onData) {
        listener(bytes);
      }
    }
  };

  const findLastHello = (): Extract<DaemonFrame, { t: 'hello' }> | undefined =>
    daemonFrames.findLast((frame) => frame.t === 'hello');

  return {
    link,
    openCount: () => connections.length,
    collectReplaceFlags: () => [...replaceFlags],
    failNextOpens: (count: number) => {
      failOpens = count;
    },
    readDaemonFrames: (): readonly DaemonFrame[] => [...daemonFrames],
    isDetached: (index: number) => connections[index]?.detached === true,

    writeGuestFrame: (frame: GuestFrame): void => {
      writeStdout(formatRelayFrame(frame));
    },
    writeGuestText: (text: string): void => {
      writeStdout(text);
    },

    answerHello: (answer: HelloAnswer): void => {
      const hello = findLastHello();

      if (hello === undefined) {
        throw new Error('the daemon sent no hello');
      }

      writeStdout(
        formatRelayFrame({
          t: 'welcome',
          v: 1,
          relay: hello.relay,
          gen: hello.gen,
          ack: answer.ack,
          reset: answer.reset,
        }),
      );
    },
    end: (end: 'dropped' | 'lost'): void => {
      const open = current();

      for (const listener of open?.onEnd ?? []) {
        listener(end);
      }
    },
  };
}
