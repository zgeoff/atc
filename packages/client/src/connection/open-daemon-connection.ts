import { connect as connectSocket } from 'node:net';
import type { Socket } from 'node:net';
import { AtcError } from '@atcx/contract/light';
import type {
  DaemonConnection,
  DaemonConnectionOptions,
  DaemonHello,
  DaemonTarget,
} from './daemon-connection';
import { startConnection, waitForConnect } from './start-connection';

// atc's own hello deadline.
const DEFAULT_TIMEOUT_MS = 8000;

// Opens one connection to a daemon, sends the hello, and resolves once the daemon accepts it.
// The connection never reconnects and never resends a call.
export async function openDaemonConnection(
  target: DaemonTarget,
  hello: DaemonHello,
  options: DaemonConnectionOptions = {},
): Promise<DaemonConnection> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (options.signal?.aborted === true) {
    throw options.signal.reason;
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort(
      new AtcError('timeout', `the daemon did not accept the hello within ${timeoutMs} ms`, {
        timeoutMs,
      }),
    );
  }, timeoutMs);

  const abortFromCaller = () => {
    controller.abort(options.signal?.reason);
  };

  options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        const reason: unknown = controller.signal.reason;
        const error = reason instanceof Error ? reason : new Error(String(reason));

        reject(error);
      },
      { once: true },
    );
  });

  const location =
    'path' in target ? { path: target.path } : { host: target.hostname, port: target.port };

  const socket = connectSocket(location);

  // A socket error is followed by the close event, which settles every call, so the handler
  // only keeps the error from going unhandled.
  socket.on('error', () => {});

  try {
    return await Promise.race([openReady(socket, target, hello, options), aborted]);
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function openReady(
  socket: Socket,
  target: DaemonTarget,
  hello: DaemonHello,
  options: DaemonConnectionOptions,
): Promise<DaemonConnection> {
  // the socket can connect while the contract loads, so both start before either is awaited
  const [contract] = await Promise.all([import('@atcx/contract'), waitForConnect(socket, target)]);
  const connection = await startConnection(socket, contract, hello, options);

  options.signal?.addEventListener(
    'abort',
    () => {
      void connection.close();
    },
    { once: true },
  );

  return connection;
}
