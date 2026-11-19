import { createDemuxer } from './create-demuxer';
import { EngineError } from './engine-error';
import { EngineUnreachableError } from './engine-unreachable-error';
import type { ContainerAttachment, StreamName } from './types';

const HEAD_END = '\r\n\r\n';
const MULTIPLEXED = 'application/vnd.docker.multiplexed-stream';

// Bun's fetch cannot keep the connection after the Engine upgrades an attach request to a raw
// stream, so this reads the HTTP response straight off the socket.
export async function openHijackedStream(
  socketPath: string,
  path: string,
): Promise<ContainerAttachment> {
  const decoder = new TextDecoder();

  const dataListeners: ((data: Uint8Array, stream: StreamName) => void)[] = [];
  const endListeners: (() => void)[] = [];
  const ready = Promise.withResolvers<void>();

  let head = new Uint8Array(0);

  let isHeadRead = false;
  let isEnded = false;

  let queued = new Uint8Array(0);

  const waiters: (() => void)[] = [];
  let demux: ReturnType<typeof createDemuxer> | null = null;

  const releaseWaiters = (): void => {
    for (const release of waiters.splice(0)) {
      release();
    }
  };

  // The Engine can send output in the same chunk as the response headers, before the caller has
  // attached a listener, so hold it here until one attaches instead of dropping it.
  const unheard: { data: Uint8Array; stream: StreamName }[] = [];

  const emit = (data: Uint8Array, stream: StreamName): void => {
    if (dataListeners.length === 0) {
      unheard.push({ data, stream });

      return;
    }

    for (const listener of dataListeners) {
      listener(data, stream);
    }
  };

  const readBody = (bytes: Uint8Array): void => {
    if (demux === null) {
      emit(bytes, 'stdout');
    } else {
      demux.feed(bytes);
    }
  };

  const readHead = (chunk: Uint8Array): void => {
    const merged = new Uint8Array(head.length + chunk.length);

    merged.set(head);
    merged.set(chunk, head.length);

    head = merged;

    const text = decoder.decode(head);
    const end = text.indexOf(HEAD_END);

    if (end === -1) {
      return;
    }

    const lines = text.slice(0, end).split('\r\n');
    const status = Number(lines[0]?.split(' ')[1]);
    const isMultiplexed = lines.some((line) => line.toLowerCase().includes(MULTIPLEXED));

    if (status !== 101 && status !== 200) {
      ready.reject(new EngineError(status, `the Engine refused ${path} with status ${status}`));

      return;
    }

    isHeadRead = true;

    if (isMultiplexed) {
      demux = createDemuxer(emit);
    }

    ready.resolve();

    const bodyStart = new TextEncoder().encode(text.slice(0, end + HEAD_END.length)).length;

    if (head.length > bodyStart) {
      readBody(head.slice(bodyStart));
    }
  };

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      open: (opened) => {
        opened.write(
          `POST ${path} HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n`,
        );
      },
      data: (_socket, chunk) => {
        if (isHeadRead) {
          readBody(chunk);
        } else {
          readHead(chunk);
        }
      },
      drain: (writable) => {
        if (queued.length > 0) {
          queued = queued.slice(writable.write(queued));
        }

        if (queued.length === 0) {
          releaseWaiters();
        }
      },
      close: () => {
        isEnded = true;

        ready.reject(new EngineUnreachableError(socketPath));

        releaseWaiters();

        for (const listener of endListeners) {
          listener();
        }
      },
      error: () => {},
    },
  }).catch((error: unknown) => {
    throw new EngineUnreachableError(socketPath, { cause: error });
  });

  try {
    await ready.promise;
  } catch (error) {
    socket.end();
    throw error;
  }

  return {
    onData: (listener) => {
      dataListeners.push(listener);

      for (const held of unheard.splice(0)) {
        listener(held.data, held.stream);
      }
    },
    onEnd: (listener) => {
      if (isEnded) {
        listener();
      } else {
        endListeners.push(listener);
      }
    },
    write: async (data) => {
      if (isEnded) {
        throw new Error('the attach ended');
      }

      const pending = new Uint8Array(queued.length + data.length);

      pending.set(queued);
      pending.set(data, queued.length);

      const written = queued.length === 0 ? socket.write(pending) : 0;

      queued = pending.slice(written);

      if (queued.length > 0) {
        const flushed = Promise.withResolvers<void>();

        waiters.push(flushed.resolve);

        await flushed.promise;

        if (isEnded && queued.length > 0) {
          throw new Error('the attach ended');
        }
      }
    },
    closeWrite: () => {
      socket.shutdown();
    },
    detach: () => {
      endListeners.length = 0;
      dataListeners.length = 0;

      socket.end();
    },
  };
}
