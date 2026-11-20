import type {
  DaemonEvent,
  DaemonFeature,
  DaemonProcedures,
  HelloResult,
  SessionID,
} from '@atcx/contract';
import { AtcError, resolveAtcPaths } from '@atcx/contract/light';
import type { DaemonConnection, DaemonTarget } from './connection/daemon-connection';
import { openDaemonConnection } from './connection/open-daemon-connection';
import { readDaemonSocketPaths } from './read-daemon-socket-paths';

export interface ConnectOptions {
  // the name the daemon logs and shows
  client?: string;

  // a unix socket; skips the socket search
  socketPath?: string;

  // a daemon over TCP; needs token and principal
  address?: { hostname: string; port: number };

  // the bearer token for address
  token?: string;

  // the principal the connection acts as; required with address
  principal?: string;

  // a second principal that narrows what the connection sees; needs principal
  viewer?: string;

  // the atc session the caller runs in; never read from the environment
  session?: SessionID;

  // connect and hello together
  timeoutMs?: number;

  // before connect() resolves, an abort cancels it; afterwards, an abort closes the client
  signal?: AbortSignal;
}

interface EventsOptions {
  signal?: AbortSignal;
}

export type AtcClient = Omit<DaemonProcedures, 'events'> & {
  events: ((options?: EventsOptions) => AsyncIterable<DaemonEvent>) &
    Pick<DaemonProcedures['events'], 'read'>;
  readonly hello: HelloResult;
  has: (feature: DaemonFeature) => boolean;
  readonly closed: Promise<void>;
  close: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

const DEFAULT_CLIENT = 'atcx-client';
const DEFAULT_TIMEOUT_MS = 8000;

// Finds the local daemon, opens its socket, sends the hello, and returns every daemon procedure.
// It never starts a daemon.
export async function connect(options: ConnectOptions = {}): Promise<AtcClient> {
  if (
    options.address !== undefined &&
    (options.principal === undefined || options.token === undefined)
  ) {
    throw new AtcError('bad_args', 'connect() with an address needs a token and a principal');
  }

  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const targets = await readTargets(options);

  const tried: string[] = [];

  for (const target of targets) {
    try {
      const connection = await openDaemonConnection(
        target,
        {
          client: options.client ?? DEFAULT_CLIENT,
          token: options.token,
          principal: options.principal,
          viewer: options.viewer,
          session: options.session,
        },
        {
          timeoutMs: Math.max(1, timeoutMs - (performance.now() - startedAt)),
          signal: options.signal,
        },
      );

      return toClient(connection);
    } catch (error) {
      if (!(error instanceof AtcError) || error.code !== 'no_daemon') {
        throw error;
      }

      tried.push(...collectTried(error));
    }
  }

  throw new AtcError('no_daemon', `no atc daemon answers at ${tried.join(', ')}`, { tried });
}

async function readTargets(options: ConnectOptions): Promise<DaemonTarget[]> {
  if (options.address !== undefined) {
    return [options.address];
  }

  if (options.socketPath !== undefined) {
    return [{ path: options.socketPath }];
  }

  const paths = await readDaemonSocketPaths(resolveAtcPaths(process.env));

  return paths.map((path) => ({ path }));
}

// Each namespace is listed by name, so a namespace that the contract gains fails the type check
// here instead of going missing from the client.
function toClient(connection: DaemonConnection): AtcClient {
  const procedures = connection.procedures;

  const events = Object.assign((eventOptions?: EventsOptions) => connection.events(eventOptions), {
    read: procedures.events.read,
  });

  return {
    daemon: procedures.daemon,
    workspaces: procedures.workspaces,
    dirs: procedures.dirs,
    agents: procedures.agents,
    sources: procedures.sources,
    git: procedures.git,
    fleet: procedures.fleet,
    session: procedures.session,
    permission: procedures.permission,
    message: procedures.message,
    notice: procedures.notice,
    note: procedures.note,
    answer: procedures.answer,
    events,
    hello: connection.hello,
    has: (feature) => connection.hello.features.includes(feature),
    closed: connection.closed,
    close: connection.close,
    [Symbol.asyncDispose]: connection.close,
  };
}

function collectTried(error: AtcError): string[] {
  const tried = error.data['tried'];

  return Array.isArray(tried) ? tried.filter((path) => typeof path === 'string') : [];
}
