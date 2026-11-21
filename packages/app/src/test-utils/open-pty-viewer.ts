import { isRecord } from '@atc/core';
import { registerTestCleanup } from '@zgeoff/testing';

type PTYViewerFrame =
  | { readonly kind: 'control'; readonly frame: Readonly<Record<string, unknown>> }
  | { readonly kind: 'output'; readonly data: string };

export interface PTYViewerClient {
  readonly socket: WebSocket;

  readonly frames: PTYViewerFrame[];

  readonly readScreen: () => string;
  readonly closed: Promise<CloseEvent>;
}

interface PTYViewerClientOptions {
  readonly token: string;
  readonly origin?: string;
}

export async function openPTYViewer(
  url: string,
  options: PTYViewerClientOptions,
): Promise<PTYViewerClient> {
  const protocols = [
    'atc.pty.v1',
    `atc.bearer.${Buffer.from(options.token).toString('base64url')}`,
  ];

  const headers = options.origin === undefined ? {} : { origin: options.origin };

  const socket = new WebSocket(url, { protocols, headers });

  const frames: PTYViewerFrame[] = [];

  const decoder = new TextDecoder();

  const closed = Promise.withResolvers<CloseEvent>();
  const opened = Promise.withResolvers<void>();

  socket.binaryType = 'arraybuffer';

  registerTestCleanup(() => {
    socket.close();
  });

  socket.addEventListener('message', (event) => {
    const payload: unknown = event.data;

    if (typeof payload === 'string') {
      const parsed: unknown = JSON.parse(payload);

      if (!isRecord(parsed)) {
        throw new Error(`a control frame holds no JSON object: ${payload}`);
      }

      frames.push({ kind: 'control', frame: parsed });
    } else if (payload instanceof ArrayBuffer) {
      frames.push({ kind: 'output', data: decoder.decode(payload) });
    }
  });

  socket.addEventListener('open', () => {
    opened.resolve();
  });

  socket.addEventListener('close', (event) => {
    opened.reject(new Error(`the socket closed before it opened, with code ${event.code}`));
    closed.resolve(event);
  });

  await opened.promise;

  return {
    socket,
    frames,
    readScreen: () => {
      const start = frames.findLastIndex(
        (entry) => entry.kind === 'control' && entry.frame['type'] === 'snapshot',
      );

      return frames
        .slice(Math.max(start, 0))
        .flatMap((entry) => {
          if (entry.kind === 'output') {
            return [entry.data];
          }

          const data = entry.frame['data'];

          return entry.frame['type'] === 'snapshot' && typeof data === 'string' ? [data] : [];
        })
        .join('');
    },
    closed: closed.promise,
  };
}
