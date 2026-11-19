import { scrubToken } from './scrub-token';
import { SpritesApiError } from './sprites-api-error';
import type { ExecConnection, ExecEnd, ExecRequest } from './types';
import { waitOut } from './wait-out';

interface ExecConnectionOptions {
  // the API's origin, `https://api.sprites.dev`
  readonly apiURL: string;
  readonly token: string;
  readonly sprite: string;
  readonly request: ExecRequest;
}

// the exec's frame prefixes on a connection that is not a terminal
const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;
const EXIT = 3;
const STDIN_EOF = 4;

// An exec over the API's WebSocket: binary frames for a terminal's bytes, and frames that lead
// with a stream id otherwise. The SDK drops the session id that a new exec that is no terminal
// announces, which the provider records to attach again.
export function openExecConnection(options: ExecConnectionOptions): ExecConnection {
  const request = options.request;

  const socket = new WebSocket(buildExecURL(options), {
    headers: { authorization: `Bearer ${options.token}` },
  });

  socket.binaryType = 'arraybuffer';

  const dataListeners: ((data: Uint8Array, stream: 'stdout' | 'stderr') => void)[] = [];
  const endListeners: ((end: ExecEnd) => void)[] = [];
  const execID = Promise.withResolvers<string>();
  const opened = Promise.withResolvers<void>();

  // an unawaited rejection never crashes the daemon
  void waitOut(execID.promise);
  void waitOut(opened.promise);
  let isEnded = false;
  let isDetached = false;

  const end = (value: ExecEnd): void => {
    if (isEnded || isDetached) {
      return;
    }

    isEnded = true;

    for (const listener of endListeners) {
      listener(value);
    }
  };

  const fail = (message: string): void => {
    const error = new SpritesApiError(null, scrubToken(message, options.token));

    execID.reject(error);
    opened.reject(error);

    end({ kind: 'dropped' });
  };

  const emitData = (data: Uint8Array, stream: 'stdout' | 'stderr'): void => {
    if (isDetached) {
      return;
    }

    for (const listener of dataListeners) {
      listener(data, stream);
    }
  };

  socket.addEventListener('open', () => {
    opened.resolve();
  });

  socket.addEventListener('error', () => {
    fail(`the exec connection to sprite ${options.sprite} failed`);
  });

  socket.addEventListener('close', () => {
    fail(`the exec connection to sprite ${options.sprite} closed`);
  });

  socket.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      readControlMessage(event.data, execID.resolve, (exitCode) => {
        end({ kind: 'exit', exitCode });
      });

      return;
    }

    if (!(event.data instanceof ArrayBuffer)) {
      return;
    }

    const bytes = new Uint8Array(event.data);

    if (request.tty) {
      emitData(bytes, 'stdout');

      return;
    }

    const payload = bytes.subarray(1);

    if (bytes[0] === STDOUT) {
      emitData(payload, 'stdout');
    } else if (bytes[0] === STDERR) {
      emitData(payload, 'stderr');
    } else if (bytes[0] === EXIT) {
      end({ kind: 'exit', exitCode: payload[0] ?? 0 });
    }
  });

  const sendControl = (message: Readonly<Record<string, unknown>>): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  return {
    execID: execID.promise,
    onData: (listener) => {
      dataListeners.push(listener);
    },
    onEnd: (listener) => {
      endListeners.push(listener);
    },
    write: async (data) => {
      await opened.promise;

      if (request.tty) {
        socket.send(data);

        return;
      }

      const frame = new Uint8Array(data.length + 1);

      frame[0] = STDIN;

      frame.set(data, 1);
      socket.send(frame);
    },
    endInput: () => {
      if (!request.tty && socket.readyState === WebSocket.OPEN) {
        socket.send(new Uint8Array([STDIN_EOF]));
      }
    },
    resize: (cols, rows) => {
      if (request.tty) {
        sendControl({ type: 'resize', cols, rows });
      }
    },
    signal: (signal) => {
      sendControl({ type: 'signal', signal });
    },
    detach: () => {
      isDetached = true;

      execID.reject(new SpritesApiError(null, `the exec on sprite ${options.sprite} was detached`));

      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, '');
      }
    },
  };
}

// a year: the longest the API takes in place of no limit
const OUTLIVE_CLIENTS = '8760h';

function buildExecURL(options: ExecConnectionOptions): string {
  const request = options.request;
  const origin = options.apiURL.replace(/^http/u, 'ws');
  const base = `${origin}/v1/sprites/${encodeURIComponent(options.sprite)}/exec`;

  if (request.execID !== undefined) {
    return `${base}/${encodeURIComponent(request.execID)}?stdin=true`;
  }

  const url = new URL(base);

  for (const part of request.argv) {
    url.searchParams.append('cmd', part);
  }

  url.searchParams.set('path', request.argv[0] ?? '');
  url.searchParams.set('stdin', 'true');

  for (const [key, value] of Object.entries(request.env ?? {})) {
    url.searchParams.append('env', `${key}=${value}`);
  }

  if (request.cwd !== undefined) {
    url.searchParams.set('dir', request.cwd);
  }

  if (request.tty) {
    url.searchParams.set('tty', 'true');
    url.searchParams.set('cols', String(request.cols ?? 80));
    url.searchParams.set('rows', String(request.rows ?? 24));
  }

  if (request.outlivesClients === true) {
    url.searchParams.set('max_run_after_disconnect', OUTLIVE_CLIENTS);
  }

  return url.toString();
}

function readControlMessage(
  text: string,
  onSession: (id: string) => void,
  onExit: (exitCode: number) => void,
): void {
  const parsed: unknown = safeParse(text);

  if (typeof parsed !== 'object' || parsed === null) {
    return;
  }

  const type = 'type' in parsed ? parsed.type : undefined;

  if (type === 'session_info' && 'session_id' in parsed) {
    onSession(String(parsed.session_id));
  } else if (type === 'exit') {
    const exitCode =
      'exit_code' in parsed && typeof parsed.exit_code === 'number' ? parsed.exit_code : 0;

    onExit(exitCode);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
